import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../lib/api";
import { PARALLEL_LIMIT, prepareRequest, redactBody, redactHeaders, runHttpStep, runItems, validateFlow, type ValidateContext } from "./engine";
import { allSteps, blankBlock, blankStep, moveItem, newFlow, parseFlow, serializeFlow, type FlowItem, type FlowStep, type IfBlock, type ParallelBlock } from "./model";
import type { VarSources } from "./vars";

const src: VarSources = { secrets: { token: "s3cret" }, vars: {}, serviceUrls: { gw: "http://localhost:4000" } };
const step = (p: Partial<FlowStep>): FlowStep => ({ ...blankStep(1), ...p });
const res = (status: number, body: unknown): HttpResponse => {
  const text = JSON.stringify(body);
  return { status, statusText: "", headers: [], contentType: "application/json", bodyText: text, bodyBase64: null, size: text.length, truncated: false, fullBodyPath: null, firstByteMs: 1, totalMs: 2 };
};
const opts = { reqId: "r1", jar: "j", insecureTls: false, root: "/w" };

describe("prepareRequest", () => {
  it("sends file bodies as project-relative paths, with the root alongside", async () => {
    const s = step({ method: "POST", url: "{{gw}}/up", body: { kind: "file", text: "", form: [], file: "payloads/a.json" } });
    const req = prepareRequest(s, src, false);
    expect(req.body).toEqual({ kind: "file", value: "payloads/a.json" });
    const sent: HttpRequest[] = [];
    await runHttpStep(s, req, opts, { send: async (r) => (sent.push(r), res(200, {})), cancelled: () => false, sleep: async () => undefined });
    expect(sent[0]).toMatchObject({ root: "/w", body: { kind: "file", value: "payloads/a.json" } });
  });

  it("reports missing variables and the secrets it used, and adds trace headers", () => {
    const req = prepareRequest(step({ url: "{{gw}}/x/{{id}}", headers: [{ key: "Authorization", value: "Bearer {{token}}" }] }), src, true);
    expect(req.missing).toEqual(["id"]);
    expect(req.usedSecrets).toEqual(["token"]);
    expect(req.headers.map(([k]) => k)).toEqual(["Authorization", "X-Request-ID", "traceparent"]);
  });
});

describe("runHttpStep", () => {
  it("polls until the condition holds, then extracts", async () => {
    let n = 0;
    const s = step({ url: "http://x", extract: [{ key: "r", value: "body.r" }], poll: { until: [{ left: "body.done", op: "==", right: "true" }], everyMs: 10, maxTries: 5 } });
    const out = await runHttpStep(s, prepareRequest(s, src, false), opts, { send: async () => res(200, { done: ++n === 3, r: "ok" }), cancelled: () => false, sleep: async () => undefined });
    expect(out).toMatchObject({ state: "passed", tries: 3, extracted: [{ key: "r", value: "ok" }] });
  });

  it("turns a refused connection into an error with the port", async () => {
    const s = step({ url: "http://localhost:4000/x" });
    const out = await runHttpStep(s, prepareRequest(s, src, false), opts, { send: () => Promise.reject("Couldn't connect to localhost:4000. Is the service running?"), cancelled: () => false, sleep: async () => undefined });
    expect(out).toMatchObject({ state: "error", refusedPort: 4000 });
  });
});

describe("retry", () => {
  const noWait = { cancelled: () => false, sleep: async () => undefined };

  it("re-sends after errors and 5xx, up to the limit, and reports attempts", async () => {
    let n = 0;
    const s = step({ url: "http://x", retry: { max: 3, backoffMs: 10, on: "errors" } });
    const waits: number[] = [];
    const out = await runHttpStep(s, prepareRequest(s, src, false), opts, {
      ...noWait,
      send: async () => (++n === 1 ? Promise.reject("Couldn't connect to x:1. Is the service running?") : res(n === 2 ? 503 : 200, {})),
      onRetry: (r) => waits.push(r.waitMs),
    });
    expect(out).toMatchObject({ state: "passed", attempts: 3, tries: 3 });
    expect(waits).toHaveLength(2);
    // Backoff doubles, with ±20% jitter.
    expect(waits[0]).toBeGreaterThanOrEqual(8);
    expect(waits[1]).toBeGreaterThanOrEqual(16);
  });

  it("doesn't retry a failed check unless told to retry on any failure", async () => {
    const s = step({ url: "http://x", checks: [{ left: "body.ok", op: "==", right: "true" }], retry: { max: 2, backoffMs: 0, on: "errors" } });
    let n = 0;
    const send = async () => (n++, res(200, { ok: n === 3 }));
    expect(await runHttpStep(s, prepareRequest(s, src, false), opts, { ...noWait, send })).toMatchObject({ state: "failed", attempts: 1 });
    n = 0;
    const any = { ...s, retry: { max: 2, backoffMs: 0, on: "any" as const } };
    expect(await runHttpStep(any, prepareRequest(any, src, false), opts, { ...noWait, send })).toMatchObject({ state: "passed", attempts: 3 });
  });

  it("gives every try its own cancel id", async () => {
    const ids: string[] = [];
    const s = step({ url: "http://x", retry: { max: 1, backoffMs: 0, on: "errors" }, poll: { until: [{ left: "body.done", op: "==", right: "true" }], everyMs: 0, maxTries: 2 } });
    await runHttpStep(s, prepareRequest(s, src, false), opts, { ...noWait, send: async (r) => (ids.push(r.id), res(500, { done: true })) });
    expect(ids).toEqual(["r1-1", "r1-2"]);
  });
});

type Out = { state: string; res?: HttpResponse };
const hooks = (results: Record<string, Out>, log: string[] = []) => ({
  run: async (s: FlowStep) => (log.push(s.id), results[s.id] ?? { state: "passed" }),
  notRun: (_s: FlowStep, why: "skipped" | "cancelled") => ({ state: why }),
  isCancelled: () => false,
});
const ids = (...names: string[]) => names.map((id) => step({ id, url: "http://x" }));
const iff = (p: Partial<IfBlock>): IfBlock => ({ ...(blankBlock("if") as IfBlock), ...p });
const par = (p: Partial<ParallelBlock>): ParallelBlock => ({ ...(blankBlock("parallel") as ParallelBlock), ...p });
const states = (r: { outcomes: Map<string, Out> }) => Object.fromEntries([...r.outcomes].map(([k, v]) => [k, v.state]));

describe("runItems", () => {
  it("skips everything after a request that fails, unless it says to continue", async () => {
    const [a, b, c] = ids("a", "b", "c");
    const stop = await runItems([a, b, c], hooks({ a: { state: "failed" } }));
    expect(states(stop)).toEqual({ a: "failed", b: "skipped", c: "skipped" });
    const go = await runItems([{ ...a, onFailure: "continue" }, b, c], hooks({ a: { state: "failed" } }));
    expect(states(go)).toEqual({ a: "failed", b: "passed", c: "passed" });
    expect(go.status).toBe("failed");
  });

  it("an if block takes a lane from the previous response", async () => {
    const [a, t, e] = ids("a", "t", "e");
    const block = iff({ id: "if1", when: [{ left: "status", op: "==", right: "404" }], then: [t], else: [e] });
    const missing = await runItems([a, block], hooks({ a: { state: "passed", res: res(404, {}) } }));
    expect(missing.branches).toEqual({ if1: "then" });
    expect(states(missing)).toEqual({ a: "passed", e: "skipped", t: "passed" });
    const found = await runItems([a, block], hooks({ a: { state: "passed", res: res(200, {}) } }));
    expect(found.branches).toEqual({ if1: "else" });
    expect(states(found)).toMatchObject({ t: "skipped", e: "passed" });
  });

  it("a parallel block starts every request, even after one fails, then stops the flow", async () => {
    const log: string[] = [];
    const [p1, p2, p3, after] = ids("p1", "p2", "p3", "after");
    const r = await runItems([par({ steps: [p1, p2, p3] }), after], hooks({ p1: { state: "failed" } }, log));
    expect(log).toEqual(["p1", "p2", "p3"]);
    expect(states(r)).toMatchObject({ p1: "failed", p2: "passed", p3: "passed", after: "skipped" });
  });

  it("a parallel block really overlaps its requests, at most PARALLEL_LIMIT at once", async () => {
    let live = 0;
    let peak = 0;
    const steps = ids("1", "2", "3", "4", "5", "6");
    await runItems([par({ steps })], {
      ...hooks({}),
      run: async () => {
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return { state: "passed" };
      },
    });
    expect(peak).toBe(PARALLEL_LIMIT);
  });

  it("cancelling marks what hasn't run as cancelled", async () => {
    let cancelled = false;
    const [a, b, c] = ids("a", "b", "c");
    const r = await runItems([a, par({ steps: [b] }), c], { ...hooks({}), run: async () => ((cancelled = true), { state: "passed" }), isCancelled: () => cancelled });
    expect(states(r)).toEqual({ a: "passed", b: "cancelled", c: "cancelled" });
    expect(r.status).toBe("cancelled");
  });
});

describe("validateFlow", () => {
  const ctx: ValidateContext = { src, envName: "local" };
  const msgs = (items: FlowItem[]) => validateFlow(items, ctx).map((i) => `${i.level}: ${i.message}`);
  const extracting = (id: string, key: string, url = "http://x") => step({ id, url, extract: [{ key, value: "body.id" }] });

  it("passes a flow whose variables are all provided in time", () => {
    expect(msgs([extracting("a", "id"), step({ id: "b", url: "{{gw}}/x/{{id}}" })])).toEqual([]);
  });

  it("finds missing URLs, unknown variables and variables provided too late", () => {
    expect(msgs([step({ id: "a", url: "" }), step({ id: "b", url: "{{gw}}/{{nope}}" }), step({ id: "c", url: "http://x/{{late}}" }), extracting("d", "late")])).toEqual([
      "error: Request 1 has no URL.",
      "error: {{nope}} has no value in “local”. Add it under Environment.",
      "error: {{late}} comes from request 4, which runs after this one.",
    ]);
  });

  it("uses the caller's explanation for a variable, such as a service with no known port", () => {
    expect(validateFlow([step({ id: "a", url: "{{orders}}/x" })], { ...ctx, explain: (n) => (n === "orders" ? "port unknown" : undefined) })[0].message).toBe("port unknown");
  });

  it("checks if blocks: a request before them, a condition, and variables set in only one lane", () => {
    const lane = iff({ id: "if1", then: [extracting("t", "maybe")], else: [] });
    expect(msgs([lane])).toContain("error: An if block reads the response of the request just before it. Put a request above this block.");
    expect(msgs([step({ id: "a", url: "http://x" }), iff({ id: "if2", when: [] })])).toEqual(["error: This if block has no condition yet.", "warning: This if block has no requests yet."]);
    expect(msgs([step({ id: "a", url: "http://x" }), lane, step({ id: "b", url: "http://x/{{maybe}}" })])).toEqual([
      "warning: {{maybe}} comes from a request inside an if block, so it's empty when that lane doesn't run.",
    ]);
  });

  it("requests sent together can't feed each other", () => {
    expect(msgs([par({ steps: [extracting("a", "id"), step({ id: "b", url: "http://x/{{id}}" })] })])).toEqual([
      "error: {{id}} comes from request 1, which is sent at the same time. Move one of them out of the block.",
    ]);
  });
});

describe("blocks in flow files", () => {
  it("round-trip with retry and onFailure, and old files still load", () => {
    const f = newFlow("flows/b.flow.json", "B");
    f.steps = [
      { ...step({ id: "a", url: "http://x" }), retry: { max: 2, backoffMs: 250, on: "any" }, onFailure: "continue" },
      iff({ id: "if1", when: [{ left: "status", op: "==", right: "404" }], then: [step({ id: "t", url: "http://t" })], else: [step({ id: "e", url: "http://e" })] }),
      par({ id: "p1", steps: [step({ id: "p", url: "http://p" })] }),
    ];
    const text = serializeFlow(f).text;
    const disk = JSON.parse(text);
    expect(disk.steps[0]).toMatchObject({ retry: { max: 2, backoffMs: 250, on: "any" }, onFailure: "continue" });
    expect(disk.steps[1]).toMatchObject({ type: "if", when: [{ left: "status", op: "==", right: 404 }], then: [{ id: "t", type: "http" }], else: [{ id: "e" }] });
    expect(disk.steps[2]).toMatchObject({ type: "parallel", steps: [{ id: "p" }] });
    expect(serializeFlow(parseFlow(f.path, text)).text).toBe(text);
    expect(allSteps(parseFlow(f.path, text).steps).map((s) => s.id)).toEqual(["a", "t", "e", "p"]);
  });

  it("moves requests between lanes, but never puts a block inside a block", () => {
    const [a, b] = ids("a", "b");
    const items: FlowItem[] = [a, iff({ id: "if1", then: [b] }), par({ id: "p1" })];
    const into = moveItem(items, "a", { lane: { block: "p1", lane: "steps" } });
    expect((into[1] as ParallelBlock).steps.map((s) => s.id)).toEqual(["a"]);
    const before = moveItem(items, "b", { before: "a" });
    expect(before.map((i) => i.id)).toEqual(["b", "a", "if1", "p1"]);
    expect(moveItem(items, "if1", { lane: { block: "p1", lane: "steps" } })).toBe(items);
    expect(moveItem(items, "p1", { before: "a" }).map((i) => i.id)).toEqual(["p1", "a", "if1"]);
  });
});

describe("redaction", () => {
  it("hides token-like JSON fields and secret values, and keeps other text as is", () => {
    const r = redactBody('{"user":"ann","accessToken":"eyJx","nested":{"password":"pw1234"},"id":12345678901234567890}', ["ann-secret"])!;
    expect(r.body).toContain('"accessToken": "••••••"');
    expect(r.body).toContain('"password": "••••••"');
    expect(r.body).toContain('"user": "ann"');
    expect(redactBody('{"id":12345678901234567890}', [])!.body).toBe('{"id":12345678901234567890}');
    expect(redactBody("Bearer s3cret-value", ["s3cret-value"])!.body).toBe("Bearer ••••••");
    expect(redactBody("x".repeat(70_000), [])!.truncated).toBe(true);
  });

  it("hides credential headers whatever their value", () => {
    expect(redactHeaders([["Authorization", "Bearer abc"], ["X-Trace", "abc s3cret"]], ["s3cret"])).toEqual([
      ["Authorization", "••••••"],
      ["X-Trace", "abc ••••••"],
    ]);
  });
});
