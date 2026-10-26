/**
 * Sending requests and running flows (docs/flows-spec.md §3, §5, §6): variables
 * from earlier responses, polling, checks, extraction, trace headers, the trace
 * itself, run history, and the connection sampler during runs.
 */
import { api, type HttpResponse } from "../lib/api";
import { getLogs } from "../state/logs";
import { selectServices, toast, useStore } from "../state/store";
import { mask, prepareRequest, runHttpStep, runSequence } from "./engine";
import type { CheckResult } from "./eval";
import { slugify, type Direction, type FlowDoc, type FlowStep, type KV } from "./model";
import { activeEnvName, rk, serviceIdFor, servicePorts, updateFlow, useFlows, varSources, write } from "./store";
import { computeTrace, correlationValues, isCorrelationValue, type TraceResult, type TraceService } from "./trace";

export type StepState = "queued" | "sending" | "polling" | "passed" | "failed" | "error" | "skipped" | "cancelled";

export interface StepOutcome {
  state: StepState;
  reqId: string;
  sentAt: number;
  finishedAt?: number;
  /** What actually went out, with secrets masked. */
  method: string;
  url: string;
  headers: [string, string][];
  tries?: number;
  res?: HttpResponse;
  error?: string;
  /** Port of the target when the connection failed, to offer starting its service. */
  refusedPort?: number;
  /** A {{service}} that couldn't resolve because its port isn't known yet. */
  missingService?: string;
  checks: CheckResult[];
  extracted: KV[];
  requestId?: string;
  traceId?: string;
  /** Trace is computed after the grace period; `tracing` covers that wait. */
  tracing?: boolean;
  trace?: TraceResult;
}

export interface FlowRunState {
  runId: string;
  status: "running" | "passed" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  env: string;
  /** Set once the run's history file is written. */
  historySavedAt?: number;
}

const get = useFlows.getState;
const set = useFlows.setState;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Outcomes are keyed by `rk(path, stepId)`; `key` is that composite key. */
function setOutcome(key: string, o: StepOutcome) {
  set((s) => ({ responses: { ...s.responses, [key]: o } }));
}

function patchOutcome(key: string, reqId: string, patch: Partial<StepOutcome>) {
  const cur = get().responses[key];
  if (cur?.reqId === reqId) setOutcome(key, { ...cur, ...patch });
}

/* ---------- one request ---------- */

interface ExecContext {
  extra: Record<string, string>;
  jar: string;
  cancelled: () => boolean;
  /** Called with each in-flight HTTP id so a run can cancel it. */
  onInflight?: (id: string | null) => void;
}

/** Sends a step through the engine and mirrors its progress into the UI state. */
async function execute(doc: FlowDoc, step: FlowStep, ctx: ExecContext): Promise<StepOutcome> {
  const key = rk(doc.path, step.id);
  const src = varSources(doc, ctx.extra);
  const reqId = newId();
  const req = prepareRequest(step, src, doc.injectHeaders);
  const shown = {
    method: req.method,
    url: mask(req.url, req.usedSecrets, src),
    headers: req.headers.map(([k, v]): [string, string] => [k, mask(v, req.usedSecrets, src)]),
  };
  const base: StepOutcome = { state: "sending", reqId, sentAt: Date.now(), ...shown, checks: [], extracted: [], requestId: req.requestId, traceId: req.traceId };

  if (req.missing.length) {
    const missing = req.missing;
    const names = missing.map((m) => `{{${m}}}`).join(", ");
    const services = selectServices(useStore.getState());
    const svcName = missing.find((m) => services.some((x) => x.name === m) || doc.services.some((f) => f.alias === m));
    const svc = svcName && (services.find((x) => x.name === svcName) ?? services.find((x) => x.id === serviceIdFor(doc.services.find((f) => f.alias === svcName)!.ref)));
    const earlier = missing.filter((m) => doc.steps.some((st) => st.extract.some((e) => e.key === m)));
    const error = svc
      ? `Not sent: Auxin doesn't know ${svc.name}'s port yet. Start it once and its port is remembered, or set its URL under Environment.`
      : earlier.length
        ? `Not sent: ${earlier.map((m) => `{{${m}}}`).join(", ")} comes from an earlier request. Send that one first, or press Run flow.`
        : `Not sent: ${names} ${missing.length > 1 ? "have" : "has"} no value in “${activeEnvName()}”. Add ${missing.length > 1 ? "them" : "it"} under Environment.`;
    const o: StepOutcome = { ...base, state: "error", finishedAt: Date.now(), error, missingService: svc ? svc.name : undefined };
    setOutcome(key, o);
    return o;
  }

  setOutcome(key, base);
  const result = await runHttpStep(
    step,
    req,
    { reqId, jar: ctx.jar, insecureTls: get().envs[activeEnvName()]?.insecureTls ?? false, root: get().root },
    {
      send: api.httpSend,
      cancelled: ctx.cancelled,
      sleep,
      onPoll: ({ tries, res }) => patchOutcome(key, reqId, res ? { res, tries } : { state: "polling", tries }),
      onInflight: ctx.onInflight,
    },
  );

  const current = get().responses[key]?.reqId === reqId ? get().responses[key] : base;
  const o: StepOutcome = { ...current, ...result, finishedAt: Date.now() };
  // Error text can echo the URL (and any secret resolved into it).
  if (o.error) o.error = mask(o.error, req.usedSecrets, src);
  if (o.state !== "cancelled" && (o.res || o.state === "error")) o.tracing = !!o.res;
  setOutcome(key, o);
  // Only secrets this request used, and long enough to be distinctive.
  if (o.res) scheduleTrace(doc, step, o, req.bodyText, req.usedSecrets.map((n) => src.secrets[n]).filter((v) => v && v.length >= 4));
  return o;
}

/* ---------- tracing ---------- */

const pendingTraces = new Map<string, Promise<void>>();

/** Waits the grace period (late log lines), then matches lines (§5). */
function scheduleTrace(doc: FlowDoc, step: FlowStep, o: StepOutcome, requestBody: string, secretValues: string[]) {
  const p = (async () => {
    await sleep(doc.graceMs);
    const s = useStore.getState();
    const services = selectServices(s);
    const flowIds = new Set(doc.services.map((f) => serviceIdFor(f.ref)));
    const aliasOf = (id: string) => doc.services.find((f) => serviceIdFor(f.ref) === id)?.alias ?? services.find((x) => x.id === id)?.name ?? id;
    const { portToService } = servicePorts(doc);
    let entry: string | undefined;
    try {
      const port = Number(new URL(o.url.replace("••••••", "x")).port || 0);
      const name = portToService[port];
      entry = name ? (services.find((x) => x.name === name)?.id ?? [...flowIds].find((id) => aliasOf(id) === name)) : undefined;
    } catch {
      entry = undefined;
    }
    const tsvcs: TraceService[] = services.map((x) => ({
      id: x.id,
      alias: aliasOf(x.id),
      // Without a service map, every running service counts as part of the flow.
      inFlow: flowIds.size ? flowIds.has(x.id) : s.runtime[x.id]?.status === "running",
      managed: !!s.runtime[x.id] || getLogs(x.id).length > 0,
    }));
    const linesByService: Record<string, ReturnType<typeof getLogs>> = {};
    for (const x of tsvcs) if (x.managed) linesByService[x.id] = getLogs(x.id);
    const ports = Object.keys(portToService).map(Number);
    const trace = computeTrace({
      requestId: o.requestId ?? "\u0000none",
      traceId: o.traceId ?? "",
      windowStart: o.sentAt - 50,
      windowEnd: (o.finishedAt ?? Date.now()) + doc.graceMs,
      entry,
      responseMs: o.res?.totalMs,
      services: tsvcs,
      linesByService,
      // Secrets never become match values (they'd show in "Matched by").
      values: correlationValues({ url: o.url, requestBody, responseBody: o.res?.bodyText, extracted: o.extracted.map((e) => e.value).filter((v) => isCorrelationValue(v, new Set(ports))), ports }).filter(
        (v) => !secretValues.some((sv) => sv && (v.includes(sv) || sv.includes(v))),
      ),
    });
    patchOutcome(rk(doc.path, step.id), o.reqId, { tracing: false, trace });
    if (trace.traffic.length) addDirections(doc.path, trace.traffic.map(([from, to]) => ({ from, to, source: "traffic", evidence: `Seen in a run: ${o.requestId} logged by ${from} then ${to}`, confirmed: false })));
  })();
  pendingTraces.set(o.reqId, p);
  void p.finally(() => pendingTraces.delete(o.reqId));
}

/** Adds directions not already present or dismissed (aliases must be in the flow map). */
export function addDirections(path: string, incoming: Direction[]) {
  updateFlow(path, (f) => {
    const aliases = new Set(f.services.map((x) => x.alias));
    const key = (d: { from: string; to: string }) => `${d.from}→${d.to}`;
    const have = new Set([...f.directions.map(key), ...f.dismissed.map(key)]);
    const add = incoming.filter((d) => d.from !== d.to && aliases.has(d.from) && aliases.has(d.to) && !have.has(key(d)) && (have.add(key(d)), true));
    return add.length ? { ...f, directions: [...f.directions, ...add] } : f;
  });
}

/* ---------- single send ---------- */

const sessionJar = (path: string) => `flow:${get().root}:${path}`;
/** In-flight HTTP id per single send, keyed by `rk(path, step)`. */
const inflight = new Map<string, string>();

export function isBusy(path: string, stepId: string): boolean {
  const st = get().responses[rk(path, stepId)]?.state;
  return st === "sending" || st === "polling";
}

export async function sendStep(path: string, step: FlowStep) {
  const doc = get().flows[path];
  // One request at a time per step, and never alongside a run of the same flow.
  if (!doc || isRunning(path) || isBusy(path, step.id)) return;
  const key = rk(path, step.id);
  cancelledSteps.delete(key);
  const o = await execute(doc, step, {
    extra: get().extracted[path] ?? {},
    jar: sessionJar(path),
    cancelled: () => cancelledSteps.has(key),
    onInflight: (id) => {
      if (id) inflight.set(key, id);
      else inflight.delete(key);
    },
  });
  cancelledSteps.delete(key);
  // Values from a single send feed later sends, so steps can be tried one by one.
  if (o.extracted.length) set((s) => ({ extracted: { ...s.extracted, [path]: { ...s.extracted[path], ...Object.fromEntries(o.extracted.map((e) => [e.key, e.value])) } } }));
}

const cancelledSteps = new Set<string>();

/** Cancels a single send; during a run, cancels the run instead. */
export function cancelStep(path: string, stepId: string) {
  if (isRunning(path)) return cancelRun(path);
  const key = rk(path, stepId);
  if (!isBusy(path, stepId)) return;
  cancelledSteps.add(key);
  const id = inflight.get(key);
  if (id) void api.httpCancel(id);
}

/* ---------- running a flow ---------- */

const runCancel = new Map<string, () => void>();

export function isRunning(path: string): boolean {
  return get().runs[path]?.status === "running";
}

export async function runFlow(path: string) {
  const doc = get().flows[path];
  if (!doc || !doc.steps.length || isRunning(path)) return;
  // A single send still in flight would overwrite its step's result mid-run.
  if (doc.steps.some((st) => isBusy(path, st.id))) {
    toast("info", "A request in this flow is still sending", "Wait for it, or cancel it, then run the flow.");
    return;
  }
  const runId = newId();
  const env = activeEnvName();
  const startedAt = Date.now();
  let cancelled = false;
  let current: string | null = null;
  runCancel.set(path, () => {
    cancelled = true;
    if (current) void api.httpCancel(current);
  });
  set((s) => ({
    runs: { ...s.runs, [path]: { runId, status: "running", startedAt, env } },
    responses: { ...s.responses, ...Object.fromEntries(doc.steps.map((st) => [rk(path, st.id), { state: "queued", reqId: `${runId}-q`, sentAt: startedAt, method: st.method, url: st.url, headers: [], checks: [], extracted: [] } as StepOutcome])) },
  }));

  const stopSampler = startConnectionSampler(path);
  const jar = `run:${runId}`;
  const extra: Record<string, string> = {};
  const { outcomes, status } = await runSequence(
    doc.steps,
    async (step) => {
      const latest = get().flows[path]?.steps.find((s) => s.id === step.id) ?? step;
      const o = await execute(get().flows[path] ?? doc, latest, { extra, jar, cancelled: () => cancelled, onInflight: (id) => (current = id) });
      for (const e of o.extracted) extra[e.key] = e.value;
      return o;
    },
    (step, why) => {
      const o: StepOutcome = { ...get().responses[rk(path, step.id)], state: why };
      setOutcome(rk(path, step.id), o);
      return o;
    },
    () => cancelled,
  );
  stopSampler();
  runCancel.delete(path);
  void api.httpDropJar(jar).catch(() => undefined);

  set((s) => ({ runs: { ...s.runs, [path]: { ...s.runs[path], status, finishedAt: Date.now() } }, extracted: { ...s.extracted, [path]: { ...s.extracted[path], ...extra } } }));

  // History includes each step's trace summary, so wait for the traces; then
  // use this run's own outcomes (a send made meanwhile must not leak in).
  await Promise.all(outcomes.map((o) => pendingTraces.get(o.reqId)).filter(Boolean));
  const final = outcomes.map((o, i) => {
    const latest = get().responses[rk(path, doc.steps[i].id)];
    return latest?.reqId === o.reqId ? latest : o;
  });
  await saveHistory(path, doc.steps, runId, env, startedAt, status, final);
  set((s) => ({ runs: { ...s.runs, [path]: { ...s.runs[path], historySavedAt: Date.now() } } }));
}

export function cancelRun(path: string) {
  runCancel.get(path)?.();
}

/* ---------- run history (§2: .auxin/runs/<flow>/, last 30) ---------- */

export interface RunRecord {
  version: 1;
  flow: string;
  runId: string;
  env: string;
  startedAt: string;
  finishedAt: string;
  status: FlowRunState["status"];
  steps: {
    id: string;
    name: string;
    method: string;
    url: string;
    state: StepState;
    status?: number;
    ms?: number;
    tries?: number;
    error?: string;
    checks: CheckResult[];
    extracted: string[];
    hops: { alias: string; ms: number; ok: boolean }[];
  }[];
}

const KEEP_RUNS = 30;
const runsDir = (path: string) => `runs/${slugify(path.replace(/^flows\//, "").replace(/\.flow\.json$/, ""))}`;

/** `steps` is the order the run used, so a mid-run reorder can't misalign outcomes. */
async function saveHistory(path: string, steps: FlowStep[], runId: string, env: string, startedAt: number, status: FlowRunState["status"], outcomes: (StepOutcome | undefined)[]) {
  const root = get().root;
  const doc = get().flows[path];
  if (!root || !doc) return;
  const rec: RunRecord = {
    version: 1,
    flow: doc.name,
    runId,
    env,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    steps: steps.map((st, i) => {
      const o = outcomes[i];
      return {
        id: st.id,
        name: st.name,
        method: st.method,
        url: o?.url ?? st.url,
        state: o?.state ?? "skipped",
        status: o?.res?.status,
        ms: o?.res?.totalMs,
        tries: o?.tries,
        error: o?.error,
        // Only status/time readings are kept; other "got" values can be tokens.
        checks: (o?.checks ?? []).map((c) => ({ label: c.label, ok: c.ok, got: /^(status|time)\b/.test(c.label) ? c.got : "" })),
        // Names only: values can be tokens returned by a login call.
        extracted: (o?.extracted ?? []).map((e) => e.key),
        hops: (o?.trace?.hops ?? []).map((h) => ({ alias: h.alias, ms: h.ms, ok: h.ok })),
      };
    }),
  };
  const dir = runsDir(path);
  await write(`${dir}/${rec.startedAt.replace(/[:.]/g, "-")}.json`, JSON.stringify(rec, null, 2) + "\n");
  try {
    const names = (await api.auxinListDir(root, dir)).filter((n) => n.endsWith(".json")).sort();
    for (const old of names.slice(0, Math.max(0, names.length - KEEP_RUNS))) await api.auxinDelete(root, `${dir}/${old}`);
  } catch {
    /* pruning is best-effort */
  }
}

export async function loadHistory(path: string): Promise<RunRecord[]> {
  const root = get().root;
  if (!root) return [];
  const dir = runsDir(path);
  try {
    const names = (await api.auxinListDir(root, dir)).filter((n) => n.endsWith(".json")).sort().reverse();
    const recs = await Promise.all(names.map((n) => api.auxinRead(root, `${dir}/${n}`).then((t) => JSON.parse(t) as RunRecord).catch(() => null)));
    return recs.filter((r): r is RunRecord => !!r);
  } catch {
    return [];
  }
}

/* ---------- connection sampling during runs (§4.4) ---------- */

function startConnectionSampler(path: string): () => void {
  const doc = get().flows[path];
  if (!doc || doc.services.length < 2) return () => undefined;
  let stopped = false;
  const seen = new Set<string>();
  const tick = async () => {
    while (!stopped) {
      const s = useStore.getState();
      const groups: [string, number][] = [];
      const portOwner: Record<number, string> = {};
      const all = selectServices(s);
      // Hints first, then live ports, so a running service always owns its port.
      for (const f of doc.services) {
        const hint = all.find((x) => x.id === serviceIdFor(f.ref))?.portHint;
        if (hint) portOwner[hint] = f.alias;
      }
      for (const f of doc.services) {
        const rt = s.runtime[serviceIdFor(f.ref)];
        if (rt?.pid) groups.push([f.alias, rt.pid]);
        if (rt?.port) portOwner[rt.port] = f.alias;
      }
      if (groups.length) {
        try {
          const pairs = await api.sampleConnections(groups, portOwner);
          const fresh = pairs.filter(([a, b]) => !seen.has(`${a}→${b}`));
          fresh.forEach(([a, b]) => seen.add(`${a}→${b}`));
          if (fresh.length) addDirections(path, fresh.map(([from, to]) => ({ from, to, source: "connection", evidence: `${from} held a TCP connection to ${to}'s port during a run`, confirmed: false })));
        } catch {
          stopped = true; // sampling is optional; never break a run over it
        }
      }
      await sleep(250);
    }
  };
  void tick();
  return () => (stopped = true);
}
