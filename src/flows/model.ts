/**
 * Flow files (`.auxin/flows/*.flow.json`) and environments (`.auxin/env/*.json`),
 * per docs/flows-spec.md §2. In memory, headers and form fields are editable
 * rows; on disk they are ordered objects. Fields this version doesn't know are
 * carried through untouched.
 *
 * Files are written as version 2, where each step names its kind
 * (`type: "http"`) and keeps the request under `http`, and `poll` is `wait`.
 * Version 1 files (flat steps) still load; they become version 2 on save.
 */

export interface KV {
  key: string;
  value: string;
}

export type BodyKind = "none" | "json" | "text" | "form" | "file";

export interface StepBody {
  kind: BodyKind;
  /** JSON or text source as the user typed it. */
  text: string;
  form: KV[];
  /** Relative to the workspace root; files outside it are never sent. */
  file: string;
}

export type CheckOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "contains" | "matches" | "exists" | "!exists" | "length ==";
export const CHECK_OPS: CheckOp[] = ["==", "!=", "<", "<=", ">", ">=", "contains", "matches", "exists", "!exists", "length =="];

export interface Check {
  /** `status`, `time`, `header.x`, `body.a.b[0]`… */
  left: string;
  op: CheckOp;
  /** The expected value as typed: JSON (`200`, `"done"`, `true`) or bare text. */
  right: string;
}

export interface Poll {
  until: Check[];
  everyMs: number;
  maxTries: number;
}

export interface FlowStep {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: KV[];
  body: StepBody;
  timeoutMs: number;
  /** variable name → path, e.g. jobId → body.jobId */
  extract: KV[];
  checks: Check[];
  poll: Poll | null;
  /** Fields this version doesn't know, preserved. */
  rest: Record<string, unknown>;
}

export type DirectionSource = "env" | "config" | "code" | "traffic" | "connection" | "manual";

export interface FlowService {
  /** Folder path relative to the workspace root. */
  ref: string;
  /** Name used in {{variables}} and on the canvas. */
  alias: string;
  x?: number;
  y?: number;
}

export interface Direction {
  from: string;
  to: string;
  source: DirectionSource;
  evidence: string;
  confirmed: boolean;
}

export interface FlowDoc {
  /** Path inside `.auxin/`, e.g. `flows/model-end-to-end.flow.json`. */
  path: string;
  name: string;
  steps: FlowStep[];
  services: FlowService[];
  directions: Direction[];
  /** Directions the user removed; detection never re-adds these. */
  dismissed: { from: string; to: string }[];
  injectHeaders: boolean;
  graceMs: number;
  /** Top-level fields this version doesn't know, preserved. */
  rest: Record<string, unknown>;
}

export interface EnvDoc {
  name: string;
  vars: Record<string, string>;
  baseUrls: Record<string, string>;
  insecureTls: boolean;
  /** From `<name>.secret.json`, never written to the shared file. */
  secrets: Record<string, string>;
}

const FLOW_KEYS = ["$schema", "version", "name", "steps", "trace", "services", "directions", "dismissed"];
const STEP_KEYS = ["id", "type", "name", "http", "method", "url", "headers", "body", "timeoutMs", "extract", "checks", "wait", "poll"];

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "flow"
  );
}

export function newStepId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** Absolute or `..` paths; the backend refuses to send these (and symlinks out). */
export function outsideWorkspace(file: string): boolean {
  return file.startsWith("/") || file.split("/").includes("..");
}

export function emptyBody(): StepBody {
  return { kind: "none", text: "", form: [], file: "" };
}

export function blankStep(n: number, url = ""): FlowStep {
  return { id: newStepId(), name: `Request ${n}`, method: "GET", url, headers: [], body: emptyBody(), timeoutMs: 30_000, extract: [], checks: [], poll: null, rest: {} };
}

/** Typed text → JSON value: `200` → 200, `"done"` → "done", `done` → "done". */
export function parseRight(text: string): unknown {
  const t = text.trim();
  if (!t) return "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** JSON value → editable text (strings keep their quotes so `"200"` ≠ `200`). */
export function rightText(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v);
}

function parseChecks(raw: unknown): Check[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({ left: String(c.left ?? ""), op: (CHECK_OPS.includes(c.op as CheckOp) ? c.op : "==") as CheckOp, right: c.op === "exists" || c.op === "!exists" ? "" : rightText(c.right) }));
}

const checkOut = (c: Check) => (c.op === "exists" || c.op === "!exists" ? { left: c.left, op: c.op } : { left: c.left, op: c.op, right: parseRight(c.right) });

const toRows = (o: unknown): KV[] => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o as Record<string, unknown>).map(([key, v]) => ({ key, value: String(v ?? "") })) : []);

const toObject = (rows: KV[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value;
  return out;
};

const pick = (o: Record<string, unknown>, skip: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !skip.includes(k)));

function parseBody(b: unknown): StepBody {
  const body = emptyBody();
  if (!b || typeof b !== "object") return body;
  const o = b as Record<string, unknown>;
  if ("json" in o) return { ...body, kind: "json", text: JSON.stringify(o.json, null, 2) };
  if ("text" in o) return { ...body, kind: "text", text: String(o.text ?? "") };
  if ("form" in o) return { ...body, kind: "form", form: toRows(o.form) };
  if ("file" in o) return { ...body, kind: "file", file: String(o.file ?? "") };
  return body;
}

/**
 * Serialised body. Invalid JSON is not written (the caller keeps the last valid
 * body on disk and shows the error), so a typo never corrupts the file.
 */
export function serializeBody(b: StepBody): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (b.kind) {
    case "none":
      return { ok: true, value: null };
    case "text":
      return { ok: true, value: { text: b.text } };
    case "form":
      return { ok: true, value: { form: toObject(b.form) } };
    case "file":
      return { ok: true, value: { file: b.file } };
    case "json": {
      // Empty stays empty (a stored `null` would come back as a literal "null" body).
      if (!b.text.trim()) return { ok: true, value: { jsonText: "" } };
      // Variables in JSON bodies are usually unquoted placeholders like {{count}};
      // swap them for a number so we can validate the rest of the document.
      try {
        JSON.parse(b.text.replace(/\{\{[^}]+\}\}/g, "0"));
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      try {
        const parsed = JSON.parse(b.text);
        // Integers beyond 2^53 (long ids) would be rounded by a parse/print round trip; keep the source.
        if ([...b.text.matchAll(/(?<![\w."])-?\d{16,}(?![\w."])/g)].some((m) => !Number.isSafeInteger(Number(m[0])))) return { ok: true, value: { jsonText: b.text } };
        return { ok: true, value: { json: parsed } };
      } catch {
        // Contains unquoted {{vars}}: keep the source text so it round-trips.
        return { ok: true, value: { jsonText: b.text } };
      }
    }
  }
}

export function parseFlow(path: string, text: string): FlowDoc {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const trace = (raw.trace ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  return {
    path,
    name: String(raw.name ?? path.replace(/^flows\//, "").replace(/\.flow\.json$/, "")),
    injectHeaders: trace.injectHeaders !== false,
    graceMs: typeof trace.graceMs === "number" ? trace.graceMs : 1500,
    rest: pick(raw, FLOW_KEYS),
    services: (Array.isArray(raw.services) ? raw.services : [])
      .filter((x: Record<string, unknown>) => x && typeof x.ref === "string")
      .map((x: Record<string, unknown>) => ({ ref: String(x.ref), alias: String(x.alias ?? String(x.ref).split("/").pop()), ...(typeof x.x === "number" ? { x: x.x } : {}), ...(typeof x.y === "number" ? { y: x.y } : {}) })),
    directions: (Array.isArray(raw.directions) ? raw.directions : [])
      .filter((d: Record<string, unknown>) => d && typeof d.from === "string" && typeof d.to === "string")
      .map((d: Record<string, unknown>) => ({ from: String(d.from), to: String(d.to), source: String(d.source ?? "manual") as DirectionSource, evidence: String(d.evidence ?? ""), confirmed: d.confirmed !== false })),
    dismissed: (Array.isArray(raw.dismissed) ? raw.dismissed : []).filter((d: Record<string, unknown>) => d && typeof d.from === "string").map((d: Record<string, unknown>) => ({ from: String(d.from), to: String(d.to) })),
    steps: steps.map((step: Record<string, unknown>) => {
      // v2 keeps the request under `http`; v1 has it on the step itself.
      const req = step.http && typeof step.http === "object" ? (step.http as Record<string, unknown>) : step;
      const s: Record<string, unknown> = { ...step, ...req, poll: step.wait ?? step.poll };
      const jsonText = s.body && typeof s.body === "object" && "jsonText" in (s.body as object) ? String((s.body as Record<string, unknown>).jsonText) : null;
      return {
        id: String(s.id ?? newStepId()),
        name: String(s.name ?? "Request"),
        method: String(s.method ?? "GET").toUpperCase(),
        url: String(s.url ?? ""),
        headers: toRows(s.headers),
        body: jsonText != null ? { ...emptyBody(), kind: "json" as const, text: jsonText } : parseBody(s.body),
        timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : 30_000,
        extract: toRows(s.extract),
        checks: parseChecks(s.checks),
        poll:
          s.poll && typeof s.poll === "object"
            ? {
                until: parseChecks((s.poll as Record<string, unknown>).until),
                everyMs: Number((s.poll as Record<string, unknown>).everyMs) || 1000,
                maxTries: Number((s.poll as Record<string, unknown>).maxTries) || 30,
              }
            : null,
        rest: pick(step, STEP_KEYS),
      };
    }),
  };
}

/** `previous` supplies the last valid body for steps whose JSON doesn't parse yet. */
export function serializeFlow(doc: FlowDoc, previous?: FlowDoc): { text: string; invalid: string[] } {
  const invalid: string[] = [];
  const steps = doc.steps.map((s) => {
    let body = serializeBody(s.body);
    if (!body.ok) {
      invalid.push(s.id);
      const prev = previous?.steps.find((p) => p.id === s.id);
      body = prev ? serializeBody(prev.body) : { ok: true, value: null };
      if (!body.ok) body = { ok: true, value: null };
    }
    return {
      id: s.id,
      type: "http",
      name: s.name,
      http: { method: s.method, url: s.url, headers: toObject(s.headers), body: body.value, timeoutMs: s.timeoutMs },
      extract: toObject(s.extract),
      checks: s.checks.filter((c) => c.left.trim()).map(checkOut),
      ...(s.poll ? { wait: { until: s.poll.until.filter((c) => c.left.trim()).map(checkOut), everyMs: s.poll.everyMs, maxTries: s.poll.maxTries } } : {}),
      ...s.rest,
    };
  });
  const out = {
    $schema: "https://auxin.dev/schema/flow-2.json",
    version: 2,
    name: doc.name,
    ...doc.rest,
    services: doc.services,
    directions: doc.directions,
    dismissed: doc.dismissed,
    trace: { injectHeaders: doc.injectHeaders, graceMs: doc.graceMs },
    steps,
  };
  return { text: JSON.stringify(out, null, 2) + "\n", invalid };
}

export function newFlow(path: string, name: string): FlowDoc {
  return { path, name, steps: [], services: [], directions: [], dismissed: [], injectHeaders: true, graceMs: 1500, rest: {} };
}

export function parseEnv(name: string, shared?: string, secret?: string): EnvDoc {
  const s = shared ? (JSON.parse(shared) as Record<string, unknown>) : {};
  const x = secret ? (JSON.parse(secret) as Record<string, unknown>) : {};
  const str = (o: unknown) => Object.fromEntries(Object.entries((o as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v ?? "")]));
  return { name, vars: str(s.vars), baseUrls: str(s.baseUrls), insecureTls: s.insecureTls === true, secrets: str(x.vars) };
}

export function serializeEnv(env: EnvDoc): { shared: string; secret: string } {
  return {
    shared: JSON.stringify({ vars: env.vars, baseUrls: env.baseUrls, ...(env.insecureTls ? { insecureTls: true } : {}) }, null, 2) + "\n",
    secret: JSON.stringify({ vars: env.secrets }, null, 2) + "\n",
  };
}
