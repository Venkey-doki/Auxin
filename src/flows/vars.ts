/**
 * `{{variable}}` resolution (docs/flows-spec.md §3). Phase 1 sources, in order:
 * secrets, environment vars, service base URLs, built-ins. Extracted values
 * (phase 2) slot in ahead of secrets via `extra`.
 */

export const VAR_RE = /\{\{\s*([\w.$-]+)\s*\}\}/g;

export interface VarSources {
  extra?: Record<string, string>;
  secrets: Record<string, string>;
  vars: Record<string, string>;
  /** Service name → base URL (env override, else http://localhost:<port>). */
  serviceUrls: Record<string, string>;
}

export type VarOrigin = "extracted" | "secret" | "env" | "service" | "builtin";

const BUILTINS: Record<string, () => string> = {
  $uuid: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoDate: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
};

export function lookup(name: string, src: VarSources): { value: string; origin: VarOrigin } | undefined {
  if (src.extra && name in src.extra) return { value: src.extra[name], origin: "extracted" };
  if (name in src.secrets) return { value: src.secrets[name], origin: "secret" };
  if (name in src.vars) return { value: src.vars[name], origin: "env" };
  if (name in src.serviceUrls) return { value: src.serviceUrls[name], origin: "service" };
  if (name in BUILTINS) return { value: BUILTINS[name](), origin: "builtin" };
  return undefined;
}

export function resolve(text: string, src: VarSources): { text: string; missing: string[]; usedSecrets: string[] } {
  const missing = new Set<string>();
  const usedSecrets = new Set<string>();
  const out = text.replace(VAR_RE, (m, name: string) => {
    const hit = lookup(name, src);
    if (!hit) {
      missing.add(name);
      return m;
    }
    if (hit.origin === "secret") usedSecrets.add(name);
    return hit.value;
  });
  return { text: out, missing: [...missing], usedSecrets: [...usedSecrets] };
}

/** Like `resolve`, but keeps secrets as `{{name}}` (for copying requests safely). */
export function resolveHidingSecrets(text: string, src: VarSources): string {
  return text.replace(VAR_RE, (m, name: string) => {
    const hit = lookup(name, src);
    return !hit || hit.origin === "secret" ? m : hit.value;
  });
}

/**
 * Turns a pasted request into a portable one: a localhost URL whose port
 * belongs to a workspace service becomes `{{service}}`, and an Authorization
 * credential moves to a secret so it never lands in a shared file.
 */
export function templatize(
  req: { url: string; headers: [string, string][] },
  portToService: Record<number, string>,
  secrets: Record<string, string>,
): { url: string; headers: [string, string][]; service?: string; newSecrets: Record<string, string>; secretName?: string } {
  let url = req.url;
  let service: string | undefined;
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?=\/|\?|#|$)/i.exec(url);
  if (m && portToService[Number(m[1])]) {
    service = portToService[Number(m[1])];
    url = `{{${service}}}${url.slice(m[0].length)}`;
  }

  const newSecrets: Record<string, string> = {};
  let secretName: string | undefined;
  const headers = req.headers.map(([k, v]): [string, string] => {
    if (!/^authorization$/i.test(k)) return [k, v];
    const auth = /^(Bearer|Basic|Token)\s*(.*)$/i.exec(v.trim());
    const scheme = auth ? auth[1] : "";
    const cred = (auth ? auth[2] : v).trim();
    if (cred.includes("{{")) return [k, v];
    // Reuse an existing secret holding the same value; otherwise token, token2, …
    const existing = Object.entries(secrets).find(([, sv]) => sv === cred && cred);
    let name = existing?.[0];
    if (!name) {
      name = "token";
      for (let i = 2; name in secrets && secrets[name] !== cred; i++) name = `token${i}`;
      if (cred) newSecrets[name] = cred;
    }
    secretName = name;
    return [k, scheme ? `${scheme} {{${name}}}` : `{{${name}}}`];
  });
  return { url, headers, service, newSecrets, secretName };
}
