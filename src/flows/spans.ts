/**
 * OpenTelemetry spans for a step: the rows of a waterfall, the hops for the
 * flow's map, and the links between services they prove. Pure, so the shapes
 * are testable without a receiver.
 *
 * Spans name their service by `service.name`, which Auxin sets to the service's
 * name when it starts it; `serviceOf` maps that back to a workspace service.
 */
import type { Span } from "../lib/api";
import type { Hop } from "./trace";

export interface SpanRow {
  span: Span;
  /** Nesting under its parent, for indentation. */
  depth: number;
  /** In another trace, reached through a link (a queue consumer, say). */
  linked: boolean;
}

/**
 * Rows in reading order: each trace as a tree (children by start time under
 * their parent), the step's own traces first, then linked ones.
 */
export function spanRows(spans: Span[], ownTraceIds: string[]): SpanRow[] {
  const own = new Set(ownTraceIds.map((t) => t.toLowerCase()));
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  const traces = [...byTrace.entries()].sort(([a, x], [b, y]) => Number(own.has(b)) - Number(own.has(a)) || x[0].startMs - y[0].startMs);
  const rows: SpanRow[] = [];
  for (const [traceId, list] of traces) {
    const ids = new Set(list.map((s) => s.spanId));
    const children = new Map<string | null, Span[]>();
    // A span whose parent never arrived (not instrumented, or still buffered) starts a root.
    for (const s of list) {
      const parent = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : null;
      children.set(parent, [...(children.get(parent) ?? []), s]);
    }
    const walk = (parent: string | null, depth: number) => {
      for (const s of (children.get(parent) ?? []).sort((a, b) => a.startMs - b.startMs)) {
        rows.push({ span: s, depth, linked: !own.has(traceId) });
        walk(s.spanId, depth + 1);
      }
    };
    walk(null, 0);
  }
  return rows;
}

/**
 * Hops for the map: each service in the order it first appears, with the time
 * of its longest span (its server or consumer span, usually) and whether any of
 * its spans failed. Timing is measured, not approximate.
 */
export function spanHops(spans: Span[], serviceOf: (name: string) => { id: string; alias: string } | undefined): Hop[] {
  const hops: Hop[] = [];
  for (const s of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const svc = serviceOf(s.service);
    if (!svc) continue;
    const h = hops.find((x) => x.service === svc.id);
    if (h) {
      h.ms = Math.max(h.ms, Math.round(s.durationMs));
      h.ok &&= s.status !== "error";
    } else hops.push({ service: svc.id, alias: svc.alias, ms: Math.round(s.durationMs), ok: s.status !== "error", approx: false });
  }
  return hops;
}

/**
 * Service-to-service links the spans prove: a span whose parent is in another
 * service (a call), and a span linking to another service's span (a message
 * consumed). Pairs are service names, deduplicated.
 */
export function spanLinks(spans: Span[]): [string, string][] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const pairs = new Set<string>();
  const add = (from: string, to: string) => from !== to && from !== "unknown" && to !== "unknown" && pairs.add(`${from}\u0000${to}`);
  for (const s of spans) {
    const parent = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
    if (parent) add(parent.service, s.service);
    for (const l of s.links) {
      const from = byId.get(l.spanId);
      if (from) add(from.service, s.service);
    }
  }
  return [...pairs].map((p) => p.split("\u0000") as [string, string]);
}

/** A few attributes worth showing next to a span's name, in this order. */
const KEY_ATTRS = [
  "http.request.method",
  "http.method",
  "http.route",
  "url.path",
  "http.target",
  "http.response.status_code",
  "http.status_code",
  "db.system",
  "db.operation.name",
  "db.operation",
  "messaging.system",
  "messaging.destination.name",
  "messaging.operation",
];

export function spanSummary(s: Span): string {
  const a = new Map(s.attributes);
  return KEY_ATTRS.map((k) => a.get(k))
    .filter((v): v is string => !!v)
    .join(" · ");
}
