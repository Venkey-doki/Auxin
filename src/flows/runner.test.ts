// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../lib/api";

const http = vi.hoisted(() => ({ handler: (_r: HttpRequest): Promise<HttpResponse> => Promise.reject("unset"), sent: [] as HttpRequest[], writes: [] as [string, string][], disk: [] as [string, string][], filesChanged: null as null | ((root: string) => void) }));

vi.mock("../lib/api", () => ({
  api: {
    httpSend: vi.fn((req: HttpRequest) => {
      http.sent.push(req);
      return http.handler(req);
    }),
    httpCancel: vi.fn(async () => true),
    httpDropJar: vi.fn(async () => undefined),
    auxinWrite: vi.fn(async (_root: string, path: string, text: string) => void http.writes.push([path, text])),
    auxinListDir: vi.fn(async () => []),
    auxinDelete: vi.fn(async () => undefined),
    auxinRead: vi.fn(async () => "{}"),
    auxinList: vi.fn(async () => http.disk.map(([path, text]) => ({ path, text }))),
    auxinWatch: vi.fn(async () => undefined),
    onFilesChanged: vi.fn(async (cb: (root: string) => void) => {
      http.filesChanged = cb;
      return () => undefined;
    }),
    sampleConnections: vi.fn(async () => []),
    discoverTopology: vi.fn(async () => ({ nodes: [], edges: [] })),
    saveConfig: vi.fn(async () => undefined),
  },
}));

import { api } from "../lib/api";
import { useMap } from "../map/store";
import { appendLogs } from "../state/logs";
import { useStore } from "../state/store";
import { blankBlock, blankQueueStep, blankStep, isStep, newFlow, parseEnv, serializeFlow, type FlowDoc, type FlowItem, type FlowStep, type IfBlock, type ParallelBlock } from "./model";
import { cancelRun, cancelStep, replayRun, runFlow, sendStep } from "./runner";
import { activeEnvName, rk, saveEnv, syncWorkspace, updateFlow, useFlows } from "./store";

const ROOT = "/w";
const res = (status: number, body: unknown, extra: Partial<HttpResponse> = {}): HttpResponse => {
  const text = JSON.stringify(body);
  return { status, statusText: "", headers: [["content-type", "application/json"]], contentType: "application/json", bodyText: text, bodyBase64: null, size: text.length, truncated: false, fullBodyPath: null, firstByteMs: 5, totalMs: 12, ...extra };
};
const step = (p: Partial<FlowStep>): FlowStep => ({ ...blankStep(1), ...p });

function setup(steps: FlowItem[], opts: Partial<FlowDoc> = {}) {
  const doc: FlowDoc = { ...newFlow("flows/e2e.flow.json", "E2E"), graceMs: 0, steps, ...opts };
  useStore.setState({
    config: { version: 1, activeWorkspaceId: "w", workspaces: [{ id: "w", root: ROOT, name: "w", overrides: {}, manual: [], hidden: [], groups: [] }] },
    detected: [
      { id: `${ROOT}/gw`, name: "gw", path: `${ROOT}/gw`, kind: "node", framework: null, suggestions: [], defaultCommand: "x", venv: null, portHint: 4000 },
      { id: `${ROOT}/model`, name: "model", path: `${ROOT}/model`, kind: "python", framework: null, suggestions: [], defaultCommand: "x", venv: null, portHint: 8000 },
    ],
    runtime: { [`${ROOT}/gw`]: { status: "running", pid: 1 }, [`${ROOT}/model`]: { status: "running", pid: 2 } },
  });
  useFlows.setState({
    root: ROOT,
    loaded: true,
    flows: { [doc.path]: doc },
    envs: { local: { ...parseEnv("local"), vars: { region: "EU" }, secrets: { token: "s3cret-token" } } },
    responses: {},
    runs: {},
    extracted: {},
    invalid: {},
    broken: {},
  });
  return doc;
}

const out = (id: string) => useFlows.getState().responses[rk("flows/e2e.flow.json", id)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  useMap.setState({ observed: [] });
  http.sent = [];
  http.writes = [];
  http.disk = [];
});

describe("runFlow", () => {
  it("chains extracted values, polls until done, checks, and records history", async () => {
    let polls = 0;
    http.handler = async (r) => {
      if (r.method === "POST") return res(202, { jobId: "8f2c1e" });
      if (r.url.endsWith("/jobs/8f2c1e")) return res(200, { status: ++polls >= 3 ? "done" : "running" });
      return res(200, { items: new Array(24).fill(1) });
    };
    const doc = setup([
      step({ id: "a", method: "POST", url: "{{gw}}/jobs", headers: [{ key: "Authorization", value: "Bearer {{token}}" }], body: { kind: "json", text: '{"region":"{{region}}"}', form: [], file: "" }, extract: [{ key: "jobId", value: "body.jobId" }], checks: [{ left: "status", op: "==", right: "202" }] }),
      step({ id: "b", url: "{{model}}/jobs/{{jobId}}", poll: { until: [{ left: "body.status", op: "==", right: '"done"' }], everyMs: 10, maxTries: 5 } }),
      step({ id: "c", url: "{{gw}}/results/{{jobId}}", checks: [{ left: "body.items", op: "length ==", right: "24" }] }),
    ]);
    await runFlow(doc.path);

    expect(useFlows.getState().runs[doc.path].status).toBe("passed");
    expect(http.sent[0]).toMatchObject({ method: "POST", url: "http://localhost:4000/jobs", body: { kind: "text", value: '{"region":"EU"}' } });
    expect(http.sent[1].url).toBe("http://localhost:8000/jobs/8f2c1e");
    expect(out("b").tries).toBe(3);
    expect(http.sent.filter((r) => r.url.endsWith("/jobs/8f2c1e"))).toHaveLength(3);
    expect(out("c").state).toBe("passed");
    // Trace headers and a shared cookie jar for the run.
    const h = Object.fromEntries(http.sent[0].headers);
    expect(h["X-Request-ID"]).toMatch(/^aux-[0-9a-f]{8}$/);
    expect(h.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(new Set(http.sent.map((r) => r.cookieJar)).size).toBe(1);
    // Secrets go out for real but are masked in what the UI shows.
    expect(h.Authorization).toBe("Bearer s3cret-token");
    expect(out("a").headers.find(([k]) => k === "Authorization")?.[1]).toBe("Bearer ••••••");
    // History: one record, values not stored (only extracted names).
    const hist = http.writes.find(([p]) => p.startsWith("runs/e2e/"));
    expect(hist).toBeTruthy();
    const rec = JSON.parse(hist![1]);
    expect(rec.status).toBe("passed");
    expect(rec.steps[0].extracted).toEqual(["jobId"]);
    expect(hist![1]).not.toContain("s3cret-token");
  });

  it("stops at the first failing check and skips the rest", async () => {
    http.handler = async () => res(500, { error: "boom" });
    const doc = setup([step({ id: "a", url: "{{gw}}/x" }), step({ id: "b", url: "{{gw}}/y" })]);
    await runFlow(doc.path);
    expect(out("a")).toMatchObject({ state: "failed", checks: [{ label: "status < 400", ok: false, got: "500" }] });
    expect(out("b").state).toBe("skipped");
    expect(useFlows.getState().runs[doc.path].status).toBe("failed");
    expect(http.sent).toHaveLength(1);
  });

  it("fails a poll that never meets its condition, saying how many tries", async () => {
    http.handler = async () => res(200, { status: "running" });
    const doc = setup([step({ id: "a", url: "{{gw}}/jobs/1", poll: { until: [{ left: "body.status", op: "==", right: '"done"' }], everyMs: 5, maxTries: 3 } })]);
    await runFlow(doc.path);
    expect(http.sent).toHaveLength(3);
    expect(out("a").state).toBe("failed");
    expect(out("a").checks[0]).toMatchObject({ ok: false, got: expect.stringContaining("not met after 3 tries") });
  });

  it("fails when an extract path is missing, so later requests don't run with a hole", async () => {
    http.handler = async () => res(200, { other: 1 });
    const doc = setup([step({ id: "a", url: "{{gw}}/a", extract: [{ key: "jobId", value: "body.jobId" }] }), step({ id: "b", url: "{{gw}}/b/{{jobId}}" })]);
    await runFlow(doc.path);
    expect(out("a").checks[out("a").checks.length - 1]).toMatchObject({ label: "extract jobId", ok: false });
    expect(out("b").state).toBe("skipped");
  });

  it("explains a connection refusal and remembers the port", async () => {
    http.handler = async () => Promise.reject("Couldn't connect to localhost:4000. Is the service running?");
    const doc = setup([step({ id: "a", url: "{{gw}}/a" })]);
    await runFlow(doc.path);
    expect(out("a")).toMatchObject({ state: "error", refusedPort: 4000 });
  });

  it("can be cancelled mid-poll", async () => {
    http.handler = async () => res(200, { status: "running" });
    const doc = setup([step({ id: "a", url: "{{gw}}/jobs/1", poll: { until: [{ left: "body.status", op: "==", right: '"done"' }], everyMs: 50, maxTries: 100 } }), step({ id: "b", url: "{{gw}}/b" })]);
    const p = runFlow(doc.path);
    await new Promise((r) => setTimeout(r, 80));
    cancelRun(doc.path);
    await p;
    expect(out("a").state).toBe("cancelled");
    expect(out("b").state).toBe("cancelled");
    expect(useFlows.getState().runs[doc.path].status).toBe("cancelled");
    expect(http.sent.length).toBeLessThan(10);
  });

  it("traces through the services' logs and records the link it saw", async () => {
    http.handler = async (r) => {
      const rid = r.headers.find(([k]) => k === "X-Request-ID")![1];
      appendLogs([
        { id: `${ROOT}/gw`, stream: "stdout", text: `POST /jobs req=${rid}`, ts: Date.now() },
        { id: `${ROOT}/model`, stream: "stdout", text: `model got req=${rid}`, ts: Date.now() + 2 },
        { id: `${ROOT}/model`, stream: "stderr", text: "ERROR job 8f2c1e failed", ts: Date.now() + 4 },
      ]);
      return res(202, { jobId: "8f2c1e" });
    };
    const doc = setup([step({ id: "a", method: "POST", url: "{{gw}}/jobs" })], { services: [{ ref: "gw", alias: "gw" }, { ref: "model", alias: "model" }], graceMs: 5 });
    await runFlow(doc.path);
    const t = out("a").trace!;
    expect(t.hops.map((h) => [h.alias, h.ok])).toEqual([
      ["gw", true],
      ["model", false],
    ]);
    expect(t.lines).toHaveLength(3);
    expect(t.traffic).toEqual([["gw", "model"]]);
    await new Promise((r) => setTimeout(r, 350)); // flow file edits are debounced
    // The link the trace showed goes to the project map, by service folder.
    expect(useMap.getState().observed).toEqual([expect.objectContaining({ from: "gw", to: "model", source: "traffic" })]);
  });
});

describe("sendStep", () => {
  it("explains a value that comes from an earlier request, and uses it once that request was sent", async () => {
    http.handler = async (r) => (r.url.endsWith("/a") ? res(200, { id: "abc12345" }) : res(200, {}));
    const doc = setup([step({ id: "a", url: "{{gw}}/a", extract: [{ key: "jobId", value: "body.id" }] }), step({ id: "b", url: "{{gw}}/b/{{jobId}}" })]);
    await sendStep(doc.path, doc.steps.filter(isStep)[1]);
    expect(out("b")).toMatchObject({ state: "error", error: expect.stringContaining("comes from an earlier request") });
    expect(http.sent).toHaveLength(0);
    await sendStep(doc.path, doc.steps.filter(isStep)[0]);
    await sendStep(doc.path, doc.steps.filter(isStep)[1]);
    expect(http.sent[http.sent.length - 1].url).toBe("http://localhost:4000/b/abc12345");
  });
});

describe("review regressions", () => {
  it("keeps secrets out of error text and run history", async () => {
    http.handler = async (r) => Promise.reject(`Request to localhost:4000 failed: connection closed (${r.url})`);
    const doc = setup([step({ id: "a", url: "{{gw}}/x?key={{token}}", checks: [{ left: "body.token", op: "exists", right: "" }] })]);
    await runFlow(doc.path);
    expect(out("a").error).not.toContain("s3cret-token");
    expect(out("a").error).toContain("••••••");
    const hist = http.writes.find(([p]) => p.startsWith("runs/"))![1];
    expect(hist).not.toContain("s3cret-token");
  });

  it("history stores status/time readings but not other response values", async () => {
    http.handler = async () => res(200, { accessToken: "tok_live_ABCDEF123456" });
    const doc = setup([step({ id: "a", url: "{{gw}}/login", checks: [{ left: "status", op: "==", right: "200" }, { left: "body.accessToken", op: "==", right: '"x"' }] })]);
    await runFlow(doc.path);
    const rec = JSON.parse(http.writes.find(([p]) => p.startsWith("runs/"))![1]);
    expect(rec.steps[0].checks[0].got).toBe("200");
    expect(rec.steps[0].checks[1].got).toBe("");
    expect(JSON.stringify(rec)).not.toContain("tok_live");
  });

  it("refuses single sends during a run, and Cancel during a run stops the run without poisoning later sends", async () => {
    let n = 0;
    http.handler = async () => {
      n++;
      await sleep(60);
      return res(200, {});
    };
    const doc = setup([step({ id: "a", url: "{{gw}}/a" }), step({ id: "b", url: "{{gw}}/b" })]);
    const p = runFlow(doc.path);
    await sleep(10);
    await sendStep(doc.path, doc.steps.filter(isStep)[0]); // ignored: the flow is running
    cancelStep(doc.path, "a"); // routes to the run
    await p;
    expect(useFlows.getState().runs[doc.path].status).toBe("cancelled");
    expect(n).toBe(1);
    await sendStep(doc.path, doc.steps.filter(isStep)[0]);
    expect(out("a").state).toBe("passed");
  });

  it("history records the run's own outcome, not a send made during the trace grace period", async () => {
    let calls = 0;
    http.handler = async () => (++calls === 1 ? res(200, {}) : res(500, {}));
    const doc = setup([step({ id: "a", url: "{{gw}}/a" })], { graceMs: 80 });
    const p = runFlow(doc.path);
    await sleep(40);
    await sendStep(doc.path, doc.steps.filter(isStep)[0]); // run has finished its requests; this one returns 500
    await p;
    const rec = JSON.parse(http.writes.find(([q]) => q.startsWith("runs/"))![1]);
    expect(rec.status).toBe("passed");
    expect(rec.steps[0].status).toBe(200);
  });

  it("doesn't use common words from extracted values as trace matches", async () => {
    http.handler = async (r) => {
      appendLogs([{ id: `${ROOT}/model`, stream: "stdout", text: "worker still running", ts: Date.now() }]);
      return r.url.endsWith("/a") ? res(200, { status: "running" }) : res(200, {});
    };
    const doc = setup([step({ id: "a", url: "{{gw}}/a", extract: [{ key: "st", value: "body.status" }] })], { services: [{ ref: "gw", alias: "gw" }, { ref: "model", alias: "model" }], graceMs: 5 });
    await runFlow(doc.path);
    expect(out("a").trace!.lines).toEqual([]);
  });

  it("a running service wins its port over a stopped service's hint", async () => {
    setup([]);
    useStore.setState((s) => ({
      detected: [...s.detected, { id: `${ROOT}/ml`, name: "ml", path: `${ROOT}/ml`, kind: "python", framework: null, suggestions: [], defaultCommand: "x", venv: null, portHint: 9000 }],
      runtime: { ...s.runtime, [`${ROOT}/model`]: { status: "running", pid: 2, port: 9000 } },
    }));
    const { servicePorts } = await import("./store");
    expect(servicePorts().portToService[9000]).toBe("model");
  });
});

describe("disk sync", () => {
  const FLOW = "flows/e2e.flow.json";

  it("a reload never drops edits that haven't been saved yet", async () => {
    http.disk = [[FLOW, JSON.stringify({ version: 1, name: "From disk", steps: [] })]];
    await syncWorkspace(null);
    await syncWorkspace(ROOT);
    expect(useFlows.getState().flows[FLOW].name).toBe("From disk");
    updateFlow(FLOW, (f) => ({ ...f, name: "Typed by me" }));
    // Another file in .auxin changes (say, a run's history) before our save fires.
    http.disk.push(["env/local.json", "{}"]);
    http.filesChanged!(ROOT);
    await sleep(270); // the watcher's debounce, then the reload
    expect(useFlows.getState().flows[FLOW].name).toBe("Typed by me");
    await sleep(150);
    expect(http.writes.some(([p, t]) => p === FLOW && t.includes("Typed by me"))).toBe(true);
  });

  it("removing the last secret rewrites the secret file instead of leaving it", async () => {
    http.disk = [
      ["env/local.json", JSON.stringify({ vars: {} })],
      ["env/local.secret.json", JSON.stringify({ vars: { token: "old" } })],
    ];
    await syncWorkspace(null);
    await syncWorkspace(ROOT);
    expect(useFlows.getState().envs.local.secrets).toEqual({ token: "old" });
    await saveEnv({ ...useFlows.getState().envs.local, secrets: {} });
    const w = http.writes.find(([p]) => p === "env/local.secret.json");
    expect(w && JSON.parse(w[1])).toEqual({ vars: {} });
  });
});

describe("control flow, history and replay", () => {
  const ifBlock = (p: Partial<IfBlock>): IfBlock => ({ ...(blankBlock("if") as IfBlock), ...p });
  const parallel = (p: Partial<ParallelBlock>): ParallelBlock => ({ ...(blankBlock("parallel") as ParallelBlock), ...p });
  const record = () => JSON.parse(http.writes.filter(([p]) => p.startsWith("runs/")).slice(-1)[0][1]);

  it("won't start a run that validation rejects, and sends nothing", async () => {
    http.handler = async () => res(200, {});
    const doc = setup([step({ id: "a", url: "{{gw}}/x/{{nope}}" })]);
    await runFlow(doc.path);
    expect(http.sent).toHaveLength(0);
    expect(useFlows.getState().runs[doc.path]).toBeUndefined();
  });

  it("takes an if lane, runs a parallel block, and records both in history", async () => {
    http.handler = async (r) => (r.url.endsWith("/find") ? res(404, {}) : res(201, { token: "tok_live_123456" }));
    const doc = setup([
      step({ id: "find", url: "{{gw}}/find", onFailure: "continue" }),
      ifBlock({ id: "if1", when: [{ left: "status", op: "==", right: "404" }], then: [step({ id: "create", method: "POST", url: "{{gw}}/create" })], else: [step({ id: "read", url: "{{gw}}/read" })] }),
      parallel({ id: "p1", steps: [step({ id: "p", url: "{{gw}}/p" }), step({ id: "q", url: "{{gw}}/q" })] }),
    ]);
    await runFlow(doc.path);
    expect(http.sent.map((r) => r.url.replace("http://localhost:4000", ""))).toEqual(["/find", "/create", "/p", "/q"]);
    expect(out("read").state).toBe("skipped");
    const run = useFlows.getState().runs[doc.path];
    expect(run.branches).toEqual({ if1: "then" });
    // find failed (404) but continues, so the run is failed overall.
    expect(run.status).toBe("failed");
    const rec = record();
    expect(rec).toMatchObject({ version: 2, branches: { if1: "then" }, snapshot: { version: 2, steps: [{ id: "find" }, { id: "if1", type: "if" }, { id: "p1", type: "parallel" }] } });
    const created = rec.steps.find((s: { id: string }) => s.id === "create");
    expect(created.response).toMatchObject({ status: 201 });
    expect(created.response.body).toContain("••••••");
    expect(JSON.stringify(rec)).not.toContain("tok_live");
  });

  it("sends the environment's network rules with every request", async () => {
    http.handler = async () => res(200, {});
    const doc = setup([step({ id: "a", url: "{{gw}}/x" })]);
    useFlows.setState((s) => ({ envs: { local: { ...s.envs.local, network: { allowPrivate: false, allowHosts: ["*.example.com"] } } } }));
    await runFlow(doc.path);
    expect(http.sent[0].policy).toEqual({ allowPrivate: false, allowHosts: ["*.example.com"], env: "local" });
  });

  it("replays the flow as it was recorded, even after it was edited", async () => {
    http.handler = async () => res(200, {});
    const doc = setup([step({ id: "a", url: "{{gw}}/original" })]);
    await runFlow(doc.path);
    const rec = record();
    updateFlow(doc.path, (f) => ({ ...f, steps: [step({ id: "a", url: "{{gw}}/edited" })] }));
    http.sent = [];
    await replayRun(doc.path, rec);
    expect(http.sent.map((r) => r.url)).toEqual(["http://localhost:4000/original"]);
    expect(record().replayOf).toBe(rec.runId);
  });

  it("Stop cancels every request a parallel block has in flight", async () => {
    http.handler = async () => {
      await sleep(200);
      return res(200, {});
    };
    const cancel = vi.mocked(api.httpCancel);
    cancel.mockClear();
    const doc = setup([parallel({ id: "p1", steps: [step({ id: "p", url: "{{gw}}/p" }), step({ id: "q", url: "{{gw}}/q" })] })]);
    const p = runFlow(doc.path);
    await sleep(20);
    cancelRun(doc.path);
    await p;
    expect(new Set(cancel.mock.calls.map(([id]) => id)).size).toBe(2);
    expect(useFlows.getState().runs[doc.path].status).toBe("cancelled");
  });
});

describe("project map handover", () => {
  it("moves links kept in an old flow file to topology.json, and writes the flow without them", async () => {
    useMap.setState({ root: null, file: { version: 1, nodes: [], edges: [], removed: [], positions: {} } });
    http.disk = [
      [
        "flows/old.flow.json",
        JSON.stringify({
          version: 1,
          name: "Old",
          services: [{ ref: "gw", alias: "gateway" }, { ref: "model", alias: "model" }],
          directions: [{ from: "gateway", to: "model", source: "env", evidence: "x", confirmed: true }, { from: "model", to: "gateway", source: "code", evidence: "y", confirmed: false }],
          dismissed: [{ from: "model", to: "gateway" }],
          steps: [],
        }),
      ],
    ];
    await syncWorkspace(null);
    await syncWorkspace(ROOT);
    await sleep(400);
    expect(useMap.getState().file).toMatchObject({ edges: [{ from: "gw", to: "model" }], removed: ["model→gw"] });
    const flow = http.writes.filter(([p]) => p === "flows/old.flow.json").slice(-1)[0];
    expect(JSON.parse(flow[1])).not.toHaveProperty("directions");
    expect(http.writes.some(([p, t]) => p === "topology.json" && t.includes('"from": "gw"'))).toBe(true);
  });
});

describe("queue steps in a run", () => {
  it("starts listening when the run starts, and asks for messages carrying this run's ids", async () => {
    const calls: { kind: string; id: string; waitMs?: number; traceIds?: string[] }[] = [];
    vi.mocked(api).stepExec = vi.fn(async (req) => {
      calls.push(req as never);
      if (req.kind === "queue.consume") return req.waitMs === 0 ? { kind: "queue.consume", messages: [], skipped: 0 } : { kind: "queue.consume", messages: [{ source: "orders", headers: [], bodyText: '{"ok":true}', bodyBase64: null, size: 11, receivedAt: 1 }], skipped: 0 };
      return { kind: "queue.publish", ms: 3, destination: "orders", partition: null, offset: null };
    }) as never;
    vi.mocked(api).stepCancel = vi.fn(async () => true) as never;
    http.handler = async () => res(200, {});
    const pub = blankQueueStep("queue.publish", "rabbit");
    const sub = blankQueueStep("queue.consume", "rabbit");
    const doc = setup([
      step({ id: "h", url: "{{gw}}/orders" }),
      { ...pub, id: "p", queue: { ...pub.queue!, destination: "orders", routingKey: "x" } },
      { ...sub, id: "c", queue: { ...sub.queue!, destination: "orders", matchRun: true } },
    ]);
    useFlows.setState((s) => ({ envs: { local: { ...s.envs.local, brokers: { rabbit: { type: "rabbitmq", url: "amqp://localhost" } } } } }));
    await runFlow(doc.path);
    // The subscription opened before the HTTP request was sent, with the same id the step then reads.
    expect(calls[0]).toMatchObject({ kind: "queue.consume", waitMs: 0 });
    expect(http.sent).toHaveLength(1);
    const read = calls.find((c) => c.kind === "queue.consume" && c.waitMs !== 0)!;
    expect(read.id).toBe(calls[0].id);
    // The HTTP request's and the publish's ids, so a consumer that passes them on matches.
    expect(read.traceIds).toEqual(expect.arrayContaining([out("h").traceId, out("p").traceId]));
    expect(out("c")).toMatchObject({ state: "passed", message: { bodyText: '{"ok":true}' } });
    expect(useFlows.getState().runs[doc.path].status).toBe("passed");
  });
});

describe("OpenTelemetry spans", () => {
  it("a step's spans replace log hops with measured ones and add links to the map", async () => {
    useStore.setState({ otel: { port: 4318, fallback: false, error: null, spans: 2 } });
    useMap.setState({ observed: [] });
    let asked: string[] = [];
    vi.mocked(api).otelSpans = vi.fn(async (ids: string[]) => {
      asked = ids;
      const base = { parentSpanId: null, kind: "server" as const, status: "unset" as const, statusMessage: null, attributes: [], links: [] };
      return [
        { ...base, traceId: ids[0], spanId: "s1", name: "POST /jobs", service: "gw", startMs: 1, durationMs: 40 },
        { ...base, traceId: ids[0], spanId: "s2", parentSpanId: "s1", name: "score", service: "model", startMs: 5, durationMs: 30, status: "error" as const },
      ];
    }) as never;
    http.handler = async () => res(200, {});
    const doc = setup([step({ id: "a", url: "{{gw}}/jobs" })], { services: [{ ref: "gw", alias: "gateway" }, { ref: "model", alias: "model" }], graceMs: 5 });
    await runFlow(doc.path);
    expect(asked).toEqual([out("a").traceId]);
    expect(out("a").trace).toMatchObject({ source: "otel", hops: [{ alias: "gateway", ms: 40, ok: true, approx: false }, { alias: "model", ms: 30, ok: false }] });
    expect(out("a").spans).toHaveLength(2);
    expect(useMap.getState().observed).toEqual([expect.objectContaining({ from: "gw", to: "model", source: "otel" })]);
    useStore.setState({ otel: null });
  });
});

describe("running in another environment", () => {
  it("uses that environment's values and network rules, records it, and leaves the active one alone", async () => {
    http.handler = async () => res(200, {});
    const doc = setup([step({ id: "a", url: "{{gw}}/x/{{region}}" })]);
    useFlows.setState((s) => ({
      envs: { ...s.envs, staging: { ...parseEnv("staging"), vars: { region: "US" }, baseUrls: { gw: "https://staging.example.com" }, network: { allowPrivate: false, allowHosts: ["*.example.com"] } } },
    }));
    await runFlow(doc.path, { env: "staging" });
    expect(http.sent[0].url).toBe("https://staging.example.com/x/US");
    expect(http.sent[0].policy).toMatchObject({ env: "staging", allowPrivate: false });
    expect(useFlows.getState().runs[doc.path].env).toBe("staging");
    expect(JSON.parse(http.writes.find(([p]) => p.startsWith("runs/"))![1]).env).toBe("staging");
    expect(activeEnvName()).toBe("local");
  });
});

describe("switching workspaces", () => {
  it("a run keeps going in its own workspace, and its results are there when you come back", async () => {
    http.handler = async () => {
      await sleep(80);
      return res(200, {});
    };
    const doc = setup([step({ id: "a", url: "{{gw}}/slow" }), step({ id: "b", url: "{{gw}}/next" })]);
    http.disk = [[doc.path, serializeFlow(doc).text]];
    const write = vi.mocked(api.auxinWrite);
    write.mockClear();
    const p = runFlow(doc.path);
    await sleep(20);
    await syncWorkspace("/other");
    // The other workspace starts clean: nothing of the first one's run shows there.
    expect(useFlows.getState().root).toBe("/other");
    expect(useFlows.getState().runs[doc.path]).toBeUndefined();
    await p;
    expect(http.sent).toHaveLength(2);
    // History went to the workspace the run belongs to.
    expect(write.mock.calls.filter(([, path]) => path.startsWith("runs/e2e/")).map(([root]) => root)).toEqual([ROOT]);
    // Nothing of it was written into the other workspace.
    expect(write.mock.calls.filter(([root]) => root === "/other")).toEqual([]);
    await syncWorkspace(ROOT);
    expect(useFlows.getState().runs[doc.path]).toMatchObject({ status: "passed" });
    expect(out("a").state).toBe("passed");
    expect(out("b").state).toBe("passed");
  });
});
