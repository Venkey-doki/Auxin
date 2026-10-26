/**
 * Tracing a request through the services' logs (docs/flows-spec.md §5).
 * Pure functions over log lines, so they're testable without the app.
 */

export interface LogLineIn {
  ts: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  plain: string;
}

export interface TraceService {
  /** Workspace service id (absolute path). */
  id: string;
  alias: string;
  /** In the flow's map (eligible for "nearby" lines). */
  inFlow: boolean;
  /** Its logs are available to Auxin (started from Auxin). */
  managed: boolean;
}

export type Tier = 1 | 2 | 3;

export interface TraceLine {
  ts: number;
  service: string;
  alias: string;
  text: string;
  tier: Tier;
  /** The id or value that matched (to highlight). */
  match?: string;
  level?: "error" | "warn";
}

export interface Hop {
  service: string;
  alias: string;
  ms: number;
  ok: boolean;
  /** True when timing comes from log spans, not a measurement. */
  approx: boolean;
}

export interface TraceResult {
  lines: TraceLine[];
  nearby: TraceLine[];
  hops: Hop[];
  matchedBy: { kind: "request-id" | "value"; label: string }[];
  /** Flow services whose logs Auxin can't see. */
  unavailable: string[];
  /** A→B pairs seen through the injected request id (for traffic directions). */
  traffic: [string, string][];
  /** `otel` when the hops come from spans (measured); otherwise they come from log lines. */
  source?: "otel" | "logs";
}

const ERROR_RE = /\b(error|exception|traceback|fatal|panic|unhandled)\b/i;
const WARN_RE = /\b(warn|warning)\b/i;

export function levelOf(l: { plain: string }): "error" | "warn" | undefined {
  if (ERROR_RE.test(l.plain)) return "error";
  if (WARN_RE.test(l.plain)) return "warn";
  return undefined;
}

/* ---------- correlation values ---------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_KEY = /^(id|uuid|guid)$|Id$|_id$/;

/** Is this string distinctive enough to find in other services' logs? */
export function isCorrelationValue(v: string, ports: Set<number> = new Set()): boolean {
  const s = v.trim();
  if (s.length < 6 || s.length > 200 || /\s/.test(s)) return false;
  if (UUID.test(s)) return true;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return s.length >= 5 && !ports.has(n) && !(n >= 2000 && n <= 2099);
  }
  // Mixed letters and digits (hex ids, base62, slugs with numbers): distinctive.
  if (/^[\w.:-]+$/.test(s) && /\d/.test(s) && /[a-z]/i.test(s)) return true;
  return false;
}

function walkValues(v: unknown, key: string, out: Set<string>, ports: Set<number>) {
  if (v == null) return;
  if (typeof v === "string" || typeof v === "number") {
    const s = String(v);
    // Fields named like ids are trusted a little more (min 4 chars).
    if (isCorrelationValue(s, ports) || (ID_KEY.test(key) && s.length >= 4 && !/\s/.test(s) && !(typeof v === "number" && ports.has(v)))) out.add(s);
    return;
  }
  if (Array.isArray(v)) v.slice(0, 200).forEach((x) => walkValues(x, key, out, ports));
  else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 500)) walkValues(x, k, out, ports);
}

function parseMaybe(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function correlationValues(input: { url: string; requestBody?: string; responseBody?: string | null; extracted?: string[]; ports?: number[] }): string[] {
  const ports = new Set(input.ports ?? []);
  const out = new Set<string>();
  try {
    const u = new URL(input.url);
    u.pathname.split("/").forEach((seg) => {
      const d = decodeURIComponent(seg);
      if (isCorrelationValue(d, ports)) out.add(d);
    });
    u.searchParams.forEach((v, k) => walkValues(v, k, out, ports));
  } catch {
    /* not a full URL */
  }
  walkValues(parseMaybe(input.requestBody), "", out, ports);
  walkValues(parseMaybe(input.responseBody), "", out, ports);
  for (const e of input.extracted ?? []) if (e.length >= 4 && !/\s/.test(e)) out.add(e);
  // Longest first so a line matching "8f2c1e-x" reports that rather than "8f2c1e".
  return [...out].sort((a, b) => b.length - a.length).slice(0, 60);
}

/* ---------- matching ---------- */

export interface TraceInput {
  requestId: string;
  traceId: string;
  windowStart: number;
  windowEnd: number;
  /** Service the request was sent to (first hop), if known. */
  entry?: string;
  /** Measured response time, used for the entry hop. */
  responseMs?: number;
  services: TraceService[];
  linesByService: Record<string, LogLineIn[]>;
  values: string[];
}

const AUX_ID = /\baux-[0-9a-f]{8}\b/g;

/** A line tagged with another Auxin request's id belongs to that request, not this one. */
function otherRequest(plain: string, mine: string): boolean {
  const ids = plain.match(AUX_ID);
  return !!ids && !ids.includes(mine);
}

export function computeTrace(input: TraceInput): TraceResult {
  const lines: TraceLine[] = [];
  const nearby: TraceLine[] = [];
  const matched = new Map<string, { kind: "request-id" | "value"; label: string }>();
  const unavailable: string[] = [];

  for (const svc of input.services) {
    const buf = input.linesByService[svc.id];
    if (!svc.managed || !buf) {
      if (svc.inFlow) unavailable.push(svc.alias);
      continue;
    }
    for (const l of buf) {
      if (l.ts < input.windowStart || l.ts > input.windowEnd || l.stream === "system") continue;
      if (otherRequest(l.plain, input.requestId)) continue;
      const base = { ts: l.ts, service: svc.id, alias: svc.alias, text: l.text, level: levelOf(l) };
      if (l.plain.includes(input.requestId) || (input.traceId && l.plain.includes(input.traceId))) {
        const m = l.plain.includes(input.requestId) ? input.requestId : input.traceId;
        lines.push({ ...base, tier: 1, match: m });
        matched.set(`id:${m}`, { kind: "request-id", label: m === input.requestId ? `x-request-id ${m}` : `traceparent ${m.slice(0, 12)}…` });
        continue;
      }
      const v = input.values.find((x) => l.plain.includes(x));
      if (v) {
        lines.push({ ...base, tier: 2, match: v });
        matched.set(`v:${v}`, { kind: "value", label: v });
      } else if (svc.inFlow) nearby.push({ ...base, tier: 3 });
    }
  }
  lines.sort((a, b) => a.ts - b.ts);
  nearby.sort((a, b) => a.ts - b.ts);

  // Hops: services in order of their first matched line; the entry service first.
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const bad = new Set<string>();
  for (const l of lines) {
    if (!first.has(l.service)) first.set(l.service, l.ts);
    last.set(l.service, l.ts);
    if (l.level === "error") bad.add(l.service);
  }
  const order = [...first.keys()].sort((a, b) => first.get(a)! - first.get(b)!);
  if (input.entry) {
    const i = order.indexOf(input.entry);
    if (i > 0) order.splice(i, 1);
    if (i !== 0) order.unshift(input.entry);
  }
  const aliasOf = (id: string) => input.services.find((s) => s.id === id)?.alias ?? id;
  const hops: Hop[] = order.map((id) => {
    const isEntry = id === input.entry && input.responseMs != null;
    return {
      service: id,
      alias: aliasOf(id),
      ms: isEntry ? input.responseMs! : Math.max(0, (last.get(id) ?? 0) - (first.get(id) ?? 0)),
      ok: !bad.has(id),
      approx: !isEntry,
    };
  });

  // Traffic: consecutive services that both logged the injected id.
  const idOrder = [...new Set(lines.filter((l) => l.tier === 1).map((l) => l.service))];
  if (input.entry && idOrder[0] !== input.entry && lines.some((l) => l.tier === 1 && l.service === input.entry)) {
    idOrder.splice(idOrder.indexOf(input.entry), 1);
    idOrder.unshift(input.entry);
  }
  const traffic: [string, string][] = [];
  for (let i = 1; i < idOrder.length; i++) traffic.push([aliasOf(idOrder[i - 1]), aliasOf(idOrder[i])]);

  return { lines, nearby, hops, matchedBy: [...matched.values()], unavailable, traffic };
}

/* ---------- ids ---------- */

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

/** `X-Request-ID` and W3C `traceparent` for one request. */
export function newTraceIds(): { requestId: string; traceId: string; traceparent: string } {
  const traceId = hex(16);
  return { requestId: `aux-${hex(4)}`, traceId, traceparent: `00-${traceId}-${hex(8)}-01` };
}
