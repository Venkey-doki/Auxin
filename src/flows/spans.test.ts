import { describe, expect, it } from "vitest";
import type { Span } from "../lib/api";
import { spanHops, spanLinks, spanRows, spanSummary } from "./spans";

const T1 = "a".repeat(32);
const T2 = "b".repeat(32);
const span = (p: Partial<Span> & { spanId: string; service: string }): Span => ({
  traceId: T1,
  parentSpanId: null,
  name: p.spanId,
  kind: "server",
  startMs: 0,
  durationMs: 10,
  status: "unset",
  statusMessage: null,
  attributes: [],
  links: [],
  ...p,
});

// api receives the request, queries postgres, publishes; the worker consumes in its own trace, linked back.
const spans: Span[] = [
  span({ spanId: "api", service: "api", startMs: 100, durationMs: 80, attributes: [["http.request.method", "POST"], ["http.route", "/orders"]] }),
  span({ spanId: "db", parentSpanId: "api", service: "api", kind: "client", startMs: 110, durationMs: 5, attributes: [["db.system", "postgresql"]] }),
  span({ spanId: "pub", parentSpanId: "api", service: "api", kind: "producer", startMs: 120, durationMs: 2 }),
  span({ spanId: "billing", parentSpanId: "api", service: "billing", startMs: 130, durationMs: 30, status: "error" }),
  span({ spanId: "consume", traceId: T2, service: "worker", kind: "consumer", startMs: 150, durationMs: 40, links: [{ traceId: T1, spanId: "pub" }] }),
];
const known: Record<string, { id: string; alias: string }> = { api: { id: "/w/api", alias: "gw" }, billing: { id: "/w/billing", alias: "billing" }, worker: { id: "/w/worker", alias: "worker" } };

describe("spans", () => {
  it("rows nest children under parents, own trace first, linked traces after", () => {
    const rows = spanRows(spans, [T1]);
    expect(rows.map((r) => [r.span.spanId, r.depth, r.linked])).toEqual([
      ["api", 0, false],
      ["db", 1, false],
      ["pub", 1, false],
      ["billing", 1, false],
      ["consume", 0, true],
    ]);
  });

  it("a span whose parent never arrived starts its own root instead of disappearing", () => {
    expect(spanRows([span({ spanId: "orphan", parentSpanId: "missing", service: "api" })], [T1])).toEqual([expect.objectContaining({ depth: 0 })]);
  });

  it("hops follow first appearance, with each service's longest span and any error", () => {
    expect(spanHops(spans, (n) => known[n])).toEqual([
      { service: "/w/api", alias: "gw", ms: 80, ok: true, approx: false },
      { service: "/w/billing", alias: "billing", ms: 30, ok: false, approx: false },
      { service: "/w/worker", alias: "worker", ms: 40, ok: true, approx: false },
    ]);
    // Spans from services Auxin doesn't know are left out of the hops.
    expect(spanHops(spans, (n) => (n === "api" ? known.api : undefined)).map((h) => h.alias)).toEqual(["gw"]);
  });

  it("links come from cross-service parents and from span links (messages)", () => {
    expect(spanLinks(spans).sort()).toEqual([
      ["api", "billing"],
      ["api", "worker"],
    ]);
  });

  it("summaries show the attributes that say what a span did", () => {
    expect(spanSummary(spans[0])).toBe("POST · /orders");
    expect(spanSummary(spans[1])).toBe("postgresql");
  });
});
