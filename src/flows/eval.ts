/**
 * Response paths, checks and extraction (docs/flows-spec.md §3).
 * Paths: `status`, `time`, `header.<name>`, `body`, `body.a.b[0].c`, `body[*].id`.
 */
import { parseRight, type Check } from "./model";

export interface ResponseView {
  status: number;
  timeMs: number;
  headers: [string, string][];
  bodyText: string | null;
}

export interface Got {
  found: boolean;
  value: unknown;
}

const jsonCache = new WeakMap<ResponseView, { v: unknown; ok: boolean }>();

function bodyJson(r: ResponseView): { v: unknown; ok: boolean } {
  let c = jsonCache.get(r);
  if (!c) {
    try {
      c = { v: r.bodyText == null ? undefined : JSON.parse(r.bodyText), ok: r.bodyText != null };
    } catch {
      c = { v: r.bodyText, ok: false };
    }
    jsonCache.set(r, c);
  }
  return c;
}

type Seg = { key: string } | { index: number } | { any: true };

/** `a.b[0]["c-d"][*]` → segments. Returns null on a malformed path. */
export function parsePath(path: string): Seg[] | null {
  const segs: Seg[] = [];
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      i++;
      continue;
    }
    if (c === "[") {
      const end = path.indexOf("]", i);
      if (end < 0) return null;
      const inner = path.slice(i + 1, end).trim();
      if (inner === "*") segs.push({ any: true });
      else if (/^-?\d+$/.test(inner)) segs.push({ index: Number(inner) });
      else if (/^(["']).*\1$/.test(inner)) segs.push({ key: inner.slice(1, -1) });
      else return null;
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
    segs.push({ key: path.slice(i, j) });
    i = j;
  }
  return segs;
}

function walk(value: unknown, segs: Seg[]): Got {
  if (!segs.length) return { found: value !== undefined, value };
  const [s, ...rest] = segs;
  if ("any" in s) {
    // First element (of an array, or value of an object) where the rest resolves.
    const items = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
    for (const it of items) {
      const g = walk(it, rest);
      if (g.found) return g;
    }
    return { found: false, value: undefined };
  }
  if ("index" in s) {
    if (!Array.isArray(value)) return { found: false, value: undefined };
    const v = value[s.index < 0 ? value.length + s.index : s.index];
    return v === undefined ? { found: false, value: undefined } : walk(v, rest);
  }
  if (value && typeof value === "object" && s.key in (value as Record<string, unknown>)) return walk((value as Record<string, unknown>)[s.key], rest);
  return { found: false, value: undefined };
}

export function getPath(path: string, r: ResponseView): Got {
  const p = path.trim();
  if (p === "status") return { found: true, value: r.status };
  if (p === "time") return { found: true, value: r.timeMs };
  if (p.toLowerCase().startsWith("header.")) {
    const name = p.slice(7).toLowerCase();
    const h = r.headers.find(([k]) => k.toLowerCase() === name);
    return h ? { found: true, value: h[1] } : { found: false, value: undefined };
  }
  if (p === "body") {
    const b = bodyJson(r);
    return { found: r.bodyText != null, value: b.v };
  }
  if (p.startsWith("body.") || p.startsWith("body[")) {
    const b = bodyJson(r);
    if (!b.ok) return { found: false, value: undefined };
    const segs = parsePath(p.slice(4));
    return segs ? walk(b.v, segs) : { found: false, value: undefined };
  }
  return { found: false, value: undefined };
}

const isNumeric = (v: unknown) => (typeof v === "number" && isFinite(v)) || (typeof v === "string" && v.trim() !== "" && isFinite(Number(v)));

function equal(a: unknown, b: unknown): boolean {
  if (isNumeric(a) && isNumeric(b) && (typeof a === "number" || typeof b === "number")) return Number(a) === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

export function show(v: unknown): string {
  if (v === undefined) return "missing";
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

export function checkLabel(c: Check): string {
  return c.op === "exists" || c.op === "!exists" ? `${c.left} ${c.op}` : `${c.left} ${c.op} ${c.right}`;
}

export interface CheckResult {
  label: string;
  ok: boolean;
  got: string;
}

export function evalCheck(c: Check, r: ResponseView): CheckResult {
  const g = getPath(c.left, r);
  const want = parseRight(c.right);
  const label = checkLabel(c);
  const got = show(g.value);
  let ok = false;
  switch (c.op) {
    case "exists":
      ok = g.found && g.value !== null;
      break;
    case "!exists":
      ok = !g.found || g.value === null;
      break;
    case "==":
      ok = g.found && equal(g.value, want);
      break;
    case "!=":
      ok = !equal(g.value, want);
      break;
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const a = Number(g.value);
      const b = Number(want);
      ok = g.found && isNumeric(g.value) && isNumeric(want) && (c.op === "<" ? a < b : c.op === "<=" ? a <= b : c.op === ">" ? a > b : a >= b);
      break;
    }
    case "contains":
      if (typeof g.value === "string") ok = g.value.includes(String(want));
      else if (Array.isArray(g.value)) ok = g.value.some((x) => equal(x, want));
      else if (g.value && typeof g.value === "object") ok = String(want) in (g.value as object);
      break;
    case "matches":
      try {
        ok = g.found && new RegExp(String(want)).test(typeof g.value === "string" ? g.value : JSON.stringify(g.value));
      } catch {
        return { label, ok: false, got: "invalid regex" };
      }
      break;
    case "length ==": {
      const len = Array.isArray(g.value) || typeof g.value === "string" ? g.value.length : g.value && typeof g.value === "object" ? Object.keys(g.value).length : undefined;
      ok = len !== undefined && len === Number(want);
      return { label, ok, got: len === undefined ? got : `length ${len}` };
    }
  }
  return { label, ok, got };
}

/** Extracted values are kept as text, ready to drop into {{variables}}. */
export function extractValue(path: string, r: ResponseView): string | undefined {
  const g = getPath(path, r);
  if (!g.found || g.value === undefined || g.value === null) return undefined;
  return typeof g.value === "string" ? g.value : JSON.stringify(g.value);
}
