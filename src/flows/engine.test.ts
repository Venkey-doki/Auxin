import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../lib/api";
import { prepareRequest, runHttpStep, runSequence } from "./engine";
import { blankStep, type FlowStep } from "./model";
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

describe("runSequence", () => {
  const steps = ["a", "b", "c"].map((id) => step({ id }));

  it("skips everything after a step that doesn't pass", async () => {
    const r = await runSequence(steps, async (s) => ({ state: s.id === "a" ? "failed" : "passed" }), (_s, why) => ({ state: why }), () => false);
    expect(r.outcomes.map((o) => o.state)).toEqual(["failed", "skipped", "skipped"]);
    expect(r.status).toBe("failed");
  });

  it("marks the rest cancelled once cancelled", async () => {
    let cancelled = false;
    const r = await runSequence(steps, async () => ((cancelled = true), { state: "passed" }), (_s, why) => ({ state: why }), () => cancelled);
    expect(r.outcomes.map((o) => o.state)).toEqual(["passed", "cancelled", "cancelled"]);
    expect(r.status).toBe("cancelled");
  });
});
