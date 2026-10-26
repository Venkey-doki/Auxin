import { describe, expect, it } from "vitest";
import { evalCheck, extractValue, getPath, parsePath, type ResponseView } from "./eval";
import { parseFlow, serializeFlow, type Check } from "./model";
import { computeTrace, correlationValues, isCorrelationValue, newTraceIds, type LogLineIn, type TraceService } from "./trace";

const res = (body: unknown, extra: Partial<ResponseView> = {}): ResponseView => ({
  status: 200,
  timeMs: 120,
  headers: [
    ["Content-Type", "application/json"],
    ["Location", "/jobs/8f2c1e"],
  ],
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
  ...extra,
});

const chk = (left: string, op: Check["op"], right = ""): Check => ({ left, op, right });

describe("paths", () => {
  const r = res({ jobId: "8f2c1e", items: [{ id: 1 }, { id: 2, tag: "x" }], "kebab-key": { v: true }, n: null });
  it("reads status, time, headers (case-insensitive) and body paths", () => {
    expect(getPath("status", r).value).toBe(200);
    expect(getPath("time", r).value).toBe(120);
    expect(getPath("header.location", r).value).toBe("/jobs/8f2c1e");
    expect(getPath("body.jobId", r).value).toBe("8f2c1e");
    expect(getPath("body.items[1].id", r).value).toBe(2);
    expect(getPath("body.items[-1].tag", r).value).toBe("x");
    expect(getPath('body["kebab-key"].v', r).value).toBe(true);
    expect(getPath("body.items[*].tag", r).value).toBe("x");
  });
  it("reports missing paths and non-JSON bodies honestly", () => {
    expect(getPath("body.nope.deeper", r).found).toBe(false);
    expect(getPath("body.items[9]", r).found).toBe(false);
    expect(getPath("header.x-missing", r).found).toBe(false);
    expect(getPath("body.a", res("plain text")).found).toBe(false);
    expect(getPath("body", res("plain text")).value).toBe("plain text");
    expect(parsePath("a[unclosed")).toBeNull();
  });
});

describe("checks", () => {
  const r = res({ status: "done", count: 24, items: new Array(24).fill(0), tags: ["a", "b"], msg: "job 8f2c ok", n: null }, { status: 202, timeMs: 340 });
  const cases: [Check, boolean][] = [
    [chk("status", "==", "202"), true],
    [chk("status", "==", "200"), false],
    [chk("status", "!=", "500"), true],
    [chk("body.status", "==", '"done"'), true],
    [chk("body.status", "==", "done"), true], // bare text is a string
    [chk("body.count", "==", '"24"'), true], // numeric loose equality
    [chk("time", "<", "500"), true],
    [chk("time", ">=", "500"), false],
    [chk("body.msg", "contains", '"8f2c"'), true],
    [chk("body.tags", "contains", '"b"'), true],
    [chk("body.msg", "matches", "^job \\w+ ok$"), true],
    [chk("body.items", "length ==", "24"), true],
    [chk("body.tags", "length ==", "3"), false],
    [chk("body.count", "exists"), true],
    [chk("body.n", "exists"), false],
    [chk("body.missing", "!exists"), true],
    [chk("body.missing", "==", "1"), false],
    [chk("header.content-type", "contains", "json"), true],
  ];
  it.each(cases)("%o → %s", (c, want) => expect(evalCheck(c, r).ok).toBe(want));

  it("reports what it got, and survives a bad regex", () => {
    expect(evalCheck(chk("body.status", "==", '"failed"'), r)).toMatchObject({ ok: false, got: '"done"', label: 'body.status == "failed"' });
    expect(evalCheck(chk("body.msg", "matches", "("), r)).toMatchObject({ ok: false, got: "invalid regex" });
  });

  it("extracts as text", () => {
    expect(extractValue("body.count", r)).toBe("24");
    expect(extractValue("body.tags", r)).toBe('["a","b"]');
    expect(extractValue("body.nope", r)).toBeUndefined();
  });
});

describe("flow file: extract, checks, poll, map", () => {
  it("round-trips typed fields", () => {
    const text = JSON.stringify({
      name: "E2E",
      services: [{ ref: "gateway", alias: "gw", x: 10, y: 20 }],
      directions: [{ from: "gw", to: "model", source: "env", evidence: "gateway/.env:3  X=1", confirmed: true }],
      dismissed: [{ from: "model", to: "gw" }],
      steps: [
        {
          id: "a",
          name: "Wait",
          method: "GET",
          url: "{{gw}}/jobs/{{jobId}}",
          extract: { result: "body.result" },
          checks: [{ left: "status", op: "==", right: 200 }, { left: "body.ok", op: "exists" }],
          poll: { until: { left: "body.status", op: "==", right: "done" }, everyMs: 500, maxTries: 10 },
        },
      ],
    });
    const doc = parseFlow("flows/e.flow.json", text);
    expect(doc.services[0]).toEqual({ ref: "gateway", alias: "gw", x: 10, y: 20 });
    expect(doc.steps[0].checks).toEqual([chk("status", "==", "200"), chk("body.ok", "exists")]);
    expect(doc.steps[0].poll).toEqual({ until: [chk("body.status", "==", '"done"')], everyMs: 500, maxTries: 10 });
    const out = JSON.parse(serializeFlow(doc).text);
    expect(out.steps[0].checks).toEqual([{ left: "status", op: "==", right: 200 }, { left: "body.ok", op: "exists" }]);
    expect(out.steps[0].wait.until).toEqual([{ left: "body.status", op: "==", right: "done" }]);
    expect(out.steps[0].extract).toEqual({ result: "body.result" });
    expect(out.dismissed).toEqual([{ from: "model", to: "gw" }]);
    expect(out.directions[0].evidence).toBe("gateway/.env:3  X=1");
  });
});

describe("correlation values", () => {
  it("keeps distinctive ids, drops ports, years, words and status codes", () => {
    expect(isCorrelationValue("8f2c1e")).toBe(true);
    expect(isCorrelationValue("7d3f2a91-4c6e-4b8a-9f21-5e0c8d4a1b37")).toBe(true);
    expect(isCorrelationValue("123456")).toBe(true);
    expect(isCorrelationValue("2024")).toBe(false);
    expect(isCorrelationValue("200")).toBe(false);
    expect(isCorrelationValue("queued")).toBe(false);
    expect(isCorrelationValue("80000", new Set([80000]))).toBe(false);
    expect(isCorrelationValue("has space 123")).toBe(false);
  });

  it("collects from URL, bodies and extracted values, longest first", () => {
    const v = correlationValues({
      url: "http://localhost:4000/v2/settings/7d3f2a91-4c6e-4b8a-9f21-5e0c8d4a1b37?run=r12345",
      requestBody: JSON.stringify({ region: "eu-west", projectId: "p7781", year: 2026 }),
      responseBody: JSON.stringify({ jobId: "8f2c1e", status: "queued", port: 4000 }),
      extracted: ["8f2c1e"],
      ports: [4000],
    });
    expect(v[0]).toBe("7d3f2a91-4c6e-4b8a-9f21-5e0c8d4a1b37");
    expect(v).toEqual(expect.arrayContaining(["r12345", "p7781", "8f2c1e"]));
    expect(v).not.toContain("queued");
    expect(v).not.toContain("4000");
    expect(v).not.toContain("2026");
    expect(v).not.toContain("eu-west");
  });
});

describe("computeTrace", () => {
  const svc = (id: string, inFlow = true, managed = true): TraceService => ({ id, alias: id.split("/").pop()!, inFlow, managed });
  const L = (ts: number, plain: string, stream: LogLineIn["stream"] = "stdout"): LogLineIn => ({ ts, plain, text: plain, stream });
  const base = {
    requestId: "aux-1a2b3c4d",
    traceId: "0af7651916cd43dd8448eb211c80319c",
    windowStart: 1000,
    windowEnd: 5000,
    entry: "/w/gateway",
    responseMs: 48,
    values: ["8f2c1e"],
  };

  it("tiers lines, orders hops, flags errors, finds traffic and unavailable services", () => {
    const t = computeTrace({
      ...base,
      services: [svc("/w/gateway"), svc("/w/router"), svc("/w/model"), svc("/w/billing", true, false), svc("/w/other", false)],
      linesByService: {
        "/w/gateway": [L(900, "before window aux-1a2b3c4d"), L(1004, "POST /jobs req=aux-1a2b3c4d"), L(1050, "GET /health 200"), L(1100, "Process exited", "system")],
        "/w/router": [L(1020, "forward req=aux-1a2b3c4d"), L(1060, "job 8f2c1e queued")],
        "/w/model": [L(1200, "job 8f2c1e start"), L(3100, "ERROR job 8f2c1e timeout")],
        "/w/other": [L(1500, "noise 8f2c1e"), L(1600, "unrelated")],
      },
    });
    expect(t.lines.map((l) => [l.alias, l.tier])).toEqual([
      ["gateway", 1],
      ["router", 1],
      ["router", 2],
      ["model", 2],
      ["other", 2],
      ["model", 2],
    ]);
    // Nearby only includes flow services; "other" isn't in the flow.
    expect(t.nearby.map((l) => l.text)).toEqual(["GET /health 200"]);
    expect(t.hops.map((h) => [h.alias, h.ms, h.ok, h.approx])).toEqual([
      ["gateway", 48, true, false],
      ["router", 40, true, true],
      ["model", 1900, false, true],
      ["other", 0, true, true],
    ]);
    expect(t.traffic).toEqual([["gateway", "router"]]);
    expect(t.unavailable).toEqual(["billing"]);
    expect(t.matchedBy.map((m) => m.kind).sort()).toEqual(["request-id", "value"]);
  });

  it("puts the entry service first even if another service logged earlier", () => {
    const t = computeTrace({ ...base, services: [svc("/w/gateway"), svc("/w/router")], linesByService: { "/w/gateway": [L(1300, "req=aux-1a2b3c4d")], "/w/router": [L(1010, "req=aux-1a2b3c4d")] } });
    expect(t.hops.map((h) => h.alias)).toEqual(["gateway", "router"]);
    expect(t.traffic).toEqual([["gateway", "router"]]);
  });

  it("ignores lines tagged with another request's id, even if they share a value", () => {
    const t = computeTrace({
      ...base,
      services: [svc("/w/gateway"), svc("/w/router")],
      linesByService: {
        "/w/gateway": [L(1004, "POST /jobs req=aux-1a2b3c4d")],
        "/w/router": [L(1030, "job 8f2c1e queued"), L(1400, "GET /jobs/8f2c1e req=aux-99999999")],
      },
    });
    expect(t.lines.map((l) => l.text)).toEqual(["POST /jobs req=aux-1a2b3c4d", "job 8f2c1e queued"]);
    expect(t.nearby).toEqual([]);
  });

  it("matches the traceparent trace-id too", () => {
    const t = computeTrace({ ...base, services: [svc("/w/router")], linesByService: { "/w/router": [L(1500, "trace_id=0af7651916cd43dd8448eb211c80319c span ok")] } });
    expect(t.lines[0]).toMatchObject({ tier: 1, match: base.traceId });
  });
});

describe("trace ids", () => {
  it("are W3C-shaped and unique", () => {
    const a = newTraceIds();
    const b = newTraceIds();
    expect(a.requestId).toMatch(/^aux-[0-9a-f]{8}$/);
    expect(a.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(a.traceparent).toContain(a.traceId);
    expect(a.requestId).not.toBe(b.requestId);
  });
});
