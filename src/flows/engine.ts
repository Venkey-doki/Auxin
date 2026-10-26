/**
 * The flow engine with no React or store access: building a request from a
 * step, sending it (polling, checks, extraction), and walking a flow's steps.
 * `runner.ts` connects it to the UI state, tracing and history. Keeping this
 * pure is what lets step kinds and control flow be tested on their own.
 */
import type { HttpBody, HttpRequest, HttpResponse, NetPolicy, QueueMessage, StepRequest, StepResult } from "../lib/api";
import { evalCheck, extractValue, type CheckResult, type ResponseView } from "./eval";
import { allSteps, isStep, type Broker, type FlowItem, type FlowStep, type KV } from "./model";
import { newTraceIds } from "./trace";
import { resolve, type VarSources } from "./vars";

/* ---------- building a request ---------- */

export interface PreparedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: HttpBody;
  /** Resolved text body, used to find correlation values in logs. */
  bodyText: string;
  /** Variables with no value; the request must not be sent. */
  missing: string[];
  usedSecrets: string[];
  requestId?: string;
  traceId?: string;
}

/** Resolves variables and adds a default Content-Type and the trace headers (§5.1). */
export function prepareRequest(step: FlowStep, src: VarSources, injectHeaders: boolean): PreparedRequest {
  const url = resolve(step.url, src);
  const headers = step.headers.filter((h) => h.key.trim()).map((h) => ({ key: h.key.trim(), ...resolve(h.value, src) }));
  const missing = new Set([...url.missing, ...headers.flatMap((h) => h.missing)]);
  const usedSecrets = new Set([...url.usedSecrets, ...headers.flatMap((h) => h.usedSecrets)]);
  const note = (r: { missing: string[]; usedSecrets: string[] }) => {
    r.missing.forEach((m) => missing.add(m));
    r.usedSecrets.forEach((m) => usedSecrets.add(m));
  };

  let body: HttpBody = { kind: "none" };
  let bodyText = "";
  let defaultType: string | undefined;
  if (step.body.kind === "json" || step.body.kind === "text") {
    const r = resolve(step.body.text, src);
    note(r);
    bodyText = r.text;
    if (bodyText) body = { kind: "text", value: bodyText };
    if (step.body.kind === "json") defaultType = "application/json";
  } else if (step.body.kind === "form") {
    const parts = step.body.form
      .filter((f) => f.key.trim())
      .map((f) => {
        const r = resolve(f.value, src);
        note(r);
        return `${encodeURIComponent(f.key.trim())}=${encodeURIComponent(r.text)}`;
      });
    bodyText = parts.join("&");
    body = { kind: "text", value: bodyText };
    defaultType = "application/x-www-form-urlencoded";
  } else if (step.body.kind === "file" && step.body.file) {
    // Relative to the project; the backend refuses anything outside it.
    body = { kind: "file", value: step.body.file };
  }

  const finalHeaders: [string, string][] = headers.map((h) => [h.key, h.text]);
  const has = (name: string) => finalHeaders.some(([k]) => k.toLowerCase() === name);
  if (defaultType && !has("content-type")) finalHeaders.push(["Content-Type", defaultType]);

  // Tag the request so its log lines can be found in every service.
  let ids: ReturnType<typeof newTraceIds> | undefined;
  if (injectHeaders) {
    ids = newTraceIds();
    const existing = finalHeaders.find(([k]) => k.toLowerCase() === "x-request-id");
    if (existing) ids.requestId = existing[1];
    else finalHeaders.push(["X-Request-ID", ids.requestId]);
    if (!has("traceparent")) finalHeaders.push(["traceparent", ids.traceparent]);
  }

  return {
    method: step.method,
    url: url.text,
    headers: finalHeaders,
    body,
    bodyText,
    missing: [...missing],
    usedSecrets: [...usedSecrets],
    requestId: ids?.requestId,
    traceId: ids?.traceId,
  };
}

/**
 * Replaces the values of the secrets a request used, and of token-like values
 * extracted earlier (`accessToken`, `sessionId`…), also in their URL-encoded form.
 */
export function mask(text: string, used: Iterable<string>, src: VarSources): string {
  const values = [...used].map((name) => src.secrets[name]);
  for (const [k, v] of Object.entries(src.extra ?? {})) if (SENSITIVE_KEY.test(k) && v.length >= 4) values.push(v);
  let out = text;
  for (const v of values) if (v) for (const form of new Set([v, encodeURIComponent(v)])) out = out.split(form).join(HIDDEN);
  return out;
}

/* ---------- sending one HTTP step ---------- */

export interface HttpStepResult {
  state: "passed" | "failed" | "error" | "cancelled";
  res?: HttpResponse;
  tries: number;
  checks: CheckResult[];
  extracted: KV[];
  error?: string;
  /** Port of the target when the connection failed, to offer starting its service. */
  refusedPort?: number;
  /** Attempts made under the step's retry rule (1 without one). */
  attempts?: number;
}

export interface HttpStepOptions {
  /** Each try is sent as `${reqId}-${n}`, which is also its cancel id. */
  reqId: string;
  jar: string;
  insecureTls: boolean;
  /** Project root; file bodies are resolved (and confined) under it. */
  root: string | null;
  /** The environment's network rules, enforced by the backend. */
  policy?: NetPolicy;
}

export interface HttpStepDeps {
  send: (req: HttpRequest) => Promise<HttpResponse>;
  cancelled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Called before each poll try, and with the response of a try whose condition isn't met yet. */
  onPoll?: (p: { tries: number; res?: HttpResponse }) => void;
  /** Called with each in-flight id so a caller can cancel it. */
  onInflight?: (id: string | null) => void;
  /** Called before waiting to re-send under a retry rule. */
  onRetry?: (r: { attempt: number; of: number; waitMs: number; last: HttpStepResult }) => void;
}

export function toView(r: HttpResponse): ResponseView {
  return { status: r.status, timeMs: r.totalMs, headers: r.headers, bodyText: r.bodyText };
}

const RETRY_CAP_MS = 30_000;

/** Whether a failed attempt should be re-sent under the step's retry rule. */
function retryable(r: HttpStepResult, on: "errors" | "any"): boolean {
  if (r.state === "passed" || r.state === "cancelled") return false;
  return on === "any" || r.state === "error" || (r.res?.status ?? 0) >= 500;
}

/**
 * Sends a prepared request (polling if configured), evaluates checks and
 * extracts values; with a retry rule, re-sends after a growing pause while
 * the attempt fails in a way the rule covers.
 */
export async function runHttpStep(step: FlowStep, req: PreparedRequest, opts: HttpStepOptions, deps: HttpStepDeps): Promise<HttpStepResult> {
  const attempts = 1 + (step.retry?.max ?? 0);
  let sent = 0;
  for (let attempt = 1; ; attempt++) {
    const r = await sendOnce(step, req, opts, deps, sent);
    sent = r.tries;
    if (attempt >= attempts || !step.retry || !retryable(r, step.retry.on)) return { ...r, attempts: attempt };
    // Exponential backoff with ±20% jitter, so retries from parallel requests don't line up.
    const wait = Math.min(RETRY_CAP_MS, step.retry.backoffMs * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4);
    deps.onRetry?.({ attempt: attempt + 1, of: attempts, waitMs: Math.round(wait), last: r });
    for (let waited = 0; waited < wait; waited += 100) {
      if (deps.cancelled()) return { ...r, state: "cancelled", error: "Cancelled.", attempts: attempt };
      await deps.sleep(Math.min(100, wait - waited));
    }
  }
}

/** One attempt: a send, or a poll loop. `sentBefore` keeps send ids unique across attempts. */
async function sendOnce(step: FlowStep, req: PreparedRequest, opts: HttpStepOptions, deps: HttpStepDeps, sentBefore: number): Promise<HttpStepResult> {
  const cancelled = (res?: HttpResponse, tries = sentBefore): HttpStepResult => ({
    state: "cancelled",
    error: "Cancelled.",
    res,
    tries,
    checks: [],
    extracted: [],
  });
  const maxTries = step.poll ? Math.max(1, step.poll.maxTries) : 1;
  let res: HttpResponse | undefined;
  let tries = 0;
  let pollUnmet: CheckResult[] = [];

  for (; tries < maxTries;) {
    if (deps.cancelled()) return cancelled(res, sentBefore + tries);
    tries++;
    if (step.poll) deps.onPoll?.({ tries });
    const id = `${opts.reqId}-${sentBefore + tries}`;
    deps.onInflight?.(id);
    try {
      res = await deps.send({
        id,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        timeoutMs: step.timeoutMs,
        followRedirects: true,
        insecureTls: opts.insecureTls,
        cookieJar: opts.jar,
        root: opts.root,
        policy: opts.policy,
      });
    } catch (e) {
      deps.onInflight?.(null);
      const msg = String(e);
      if (msg === "Cancelled" || deps.cancelled()) return cancelled(res, sentBefore + tries);
      const port = /:(\d{2,5})\b/.exec(/Couldn't connect to ([^.]+)/.exec(msg)?.[1] ?? "")?.[1];
      return { state: "error", error: msg, refusedPort: port ? Number(port) : undefined, res, tries: sentBefore + tries, checks: [], extracted: [] };
    }
    deps.onInflight?.(null);
    if (!step.poll) break;
    pollUnmet = step.poll.until
      .filter((c) => c.left.trim())
      .map((c) => evalCheck(c, toView(res!)))
      .filter((r) => !r.ok);
    if (!pollUnmet.length) break;
    if (tries < maxTries) {
      deps.onPoll?.({ tries, res });
      for (let waited = 0; waited < step.poll.everyMs; waited += 100) {
        if (deps.cancelled()) return cancelled(res, sentBefore + tries);
        await deps.sleep(Math.min(100, step.poll.everyMs - waited));
      }
    }
  }

  const view = toView(res!);
  const checks = step.checks.filter((c) => c.left.trim()).map((c) => evalCheck(c, view));
  // With no checks of its own, a request fails on an HTTP error status.
  if (!step.checks.some((c) => c.left.trim())) checks.push({ label: "status < 400", ok: res!.status < 400, got: String(res!.status) });
  if (step.poll && pollUnmet.length)
    checks.unshift({
      label: `poll until ${pollUnmet.map((p) => p.label).join(" and ")}`,
      ok: false,
      got: `not met after ${tries} tries (${pollUnmet[0].got})`,
    });
  const extracted: KV[] = [];
  const missingExtract: string[] = [];
  for (const e of step.extract.filter((x) => x.key.trim() && x.value.trim())) {
    const v = extractValue(e.value, view);
    if (v === undefined) missingExtract.push(e.key);
    else extracted.push({ key: e.key.trim(), value: v });
  }
  if (missingExtract.length) checks.push({ label: `extract ${missingExtract.join(", ")}`, ok: false, got: "path not found in response" });
  return { state: checks.every((c) => c.ok) ? "passed" : "failed", res, tries: sentBefore + tries, checks, extracted };
}

/* ---------- queue steps ---------- */

export interface PreparedQueue {
  broker?: Broker;
  destination: string;
  routingKey: string;
  key: string;
  headers: [string, string][];
  body: string;
  missing: string[];
  usedSecrets: string[];
  requestId?: string;
  traceId?: string;
}

/** Resolves variables in a queue step (broker URL included) and, for publish, adds the trace headers. */
export function prepareQueue(step: FlowStep, src: VarSources, brokers: Record<string, Broker>, injectHeaders: boolean): PreparedQueue {
  const q = step.queue!;
  const missing = new Set<string>();
  const usedSecrets = new Set<string>();
  const r = (text: string) => {
    const out = resolve(text, src);
    out.missing.forEach((m) => missing.add(m));
    out.usedSecrets.forEach((m) => usedSecrets.add(m));
    return out.text;
  };
  const b = brokers[q.broker];
  const broker = b ? { type: b.type, url: r(b.url) } : undefined;
  const headers: [string, string][] = step.type === "queue.publish" ? q.headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), r(h.value)]) : [];
  const out: PreparedQueue = {
    broker,
    destination: r(q.destination),
    routingKey: r(q.routingKey),
    key: r(q.key),
    headers,
    body: step.type === "queue.publish" ? r(q.body) : "",
    missing: [],
    usedSecrets: [],
  };
  if (injectHeaders && step.type === "queue.publish") {
    // The same ids as an HTTP request, so a consumer that logs or forwards them can be traced.
    const ids = newTraceIds();
    const has = (n: string) => headers.find(([k]) => k.toLowerCase() === n);
    out.requestId = has("x-request-id")?.[1] ?? ids.requestId;
    if (!has("x-request-id")) headers.push(["X-Request-ID", ids.requestId]);
    if (!has("traceparent")) headers.push(["traceparent", ids.traceparent]);
    out.traceId = ids.traceId;
  }
  out.missing = [...missing];
  out.usedSecrets = [...usedSecrets];
  return out;
}

function queueIssues(s: FlowStep, n: number, ctx: ValidateContext): Issue[] {
  const q = s.queue!;
  const b = ctx.brokers?.[q.broker];
  const err = (message: string): Issue[] => [{ id: s.id, level: "error", message }];
  if (!q.broker) return err(`Step ${n} has no broker. Pick one, or add one under Environment.`);
  if (!b) return err(`There's no broker “${q.broker}” in “${ctx.envName}”. Add it under Environment.`);
  if (b.type === "kafka" && !q.destination.trim()) return err(`Step ${n} has no topic.`);
  if (s.type === "queue.publish" && !q.destination.trim() && !q.routingKey.trim())
    return err(`Step ${n} has no exchange or routing key. To send straight to a queue, leave the exchange empty and put the queue name in the routing key.`);
  if (s.type === "queue.consume" && b.type === "rabbitmq" && !q.destination.trim())
    return err(
      `Step ${n} needs an exchange to listen on. Auxin listens through its own temporary queue, so it can't watch a queue directly without taking messages from your workers.`,
    );
  return [];
}

/** A received message as checks and extraction see it: `header.<name>` and `body…` work as for responses. */
export function messageView(m: QueueMessage): ResponseView {
  return { status: 0, timeMs: 0, headers: m.headers, bodyText: m.bodyText };
}

export interface QueueStepResult {
  state: "passed" | "failed" | "error" | "cancelled";
  tries: number;
  checks: CheckResult[];
  extracted: KV[];
  error?: string;
  /** Consume: the message that matched. */
  message?: QueueMessage;
  /** Consume: messages received but not matching, and messages from other runs left out. */
  seen?: number;
  skipped?: number;
  /** Publish: where it went. */
  published?: { ms: number; destination: string; partition?: number | null; offset?: number | null };
}

export interface QueueStepOptions {
  /** Request id; also the subscription id of a consume step unless `subscription` is given. */
  reqId: string;
  /** An already-open subscription (a run opens one per consume step when it starts). */
  subscription?: string;
  /** Consume with matchRun: the trace / request ids of this run's steps so far. */
  traceIds: () => string[];
  policy?: NetPolicy;
}

export interface QueueStepDeps {
  exec: (req: StepRequest) => Promise<StepResult>;
  cancel: (id: string) => Promise<unknown>;
  cancelled: () => boolean;
  now?: () => number;
}

/** Longest single wait for messages, so Stop is noticed quickly. */
const CONSUME_SLICE_MS = 1000;

export async function runQueueStep(step: FlowStep, prep: PreparedQueue, opts: QueueStepOptions, deps: QueueStepDeps): Promise<QueueStepResult> {
  const q = step.queue!;
  const base = { tries: 1, checks: [] as CheckResult[], extracted: [] as KV[] };
  const fail = (e: unknown): QueueStepResult =>
    String(e) === "Cancelled" || deps.cancelled() ? { ...base, state: "cancelled", error: "Cancelled." } : { ...base, state: "error", error: String(e) };
  if (!prep.broker) return { ...base, state: "error", error: `There's no broker “${q.broker}” in this environment.` };

  if (step.type === "queue.publish") {
    try {
      const r = await deps.exec({
        kind: "queue.publish",
        id: opts.reqId,
        broker: prep.broker,
        destination: prep.destination,
        routingKey: prep.routingKey || null,
        key: prep.key || null,
        headers: prep.headers,
        body: prep.body,
        policy: opts.policy,
      });
      if (r.kind !== "queue.publish") throw new Error("Unexpected reply");
      return { ...base, state: "passed", published: { ms: r.ms, destination: r.destination, partition: r.partition, offset: r.offset } };
    } catch (e) {
      return fail(e);
    }
  }

  const now = deps.now ?? Date.now;
  const sub = opts.subscription ?? opts.reqId;
  const deadline = now() + q.timeoutMs;
  const conditions = step.checks.filter((c) => c.left.trim());
  let seen = 0;
  let skipped = 0;
  try {
    while (!deps.cancelled()) {
      const wait = Math.max(0, Math.min(CONSUME_SLICE_MS, deadline - now()));
      const r = await deps.exec({
        kind: "queue.consume",
        id: sub,
        broker: prep.broker,
        source: prep.destination,
        binding: prep.routingKey || null,
        traceIds: q.matchRun ? opts.traceIds() : [],
        waitMs: wait,
        policy: opts.policy,
      });
      if (r.kind !== "queue.consume") throw new Error("Unexpected reply");
      skipped += r.skipped;
      for (const m of r.messages) {
        seen++;
        const view = messageView(m);
        const checks = conditions.map((c) => evalCheck(c, view));
        if (!checks.every((c) => c.ok)) continue;
        const extracted: KV[] = [];
        const missingExtract: string[] = [];
        for (const e of step.extract.filter((x) => x.key.trim() && x.value.trim())) {
          const v = extractValue(e.value, view);
          if (v === undefined) missingExtract.push(e.key);
          else extracted.push({ key: e.key.trim(), value: v });
        }
        if (missingExtract.length) checks.push({ label: `extract ${missingExtract.join(", ")}`, ok: false, got: "path not found in the message" });
        return { ...base, state: checks.every((c) => c.ok) ? "passed" : "failed", checks, extracted, message: m, seen, skipped };
      }
      if (now() >= deadline) break;
    }
    if (deps.cancelled()) return { ...base, state: "cancelled", error: "Cancelled.", seen, skipped };
    const where = q.destination || q.routingKey;
    const other = [seen && `${seen} other message${seen === 1 ? "" : "s"} didn't match`, skipped && `${skipped} from other runs were left out`]
      .filter(Boolean)
      .join("; ");
    return {
      ...base,
      state: "failed",
      seen,
      skipped,
      checks: [{ label: `message on ${where}`, ok: false, got: `none within ${Math.round(q.timeoutMs / 1000)}s${other ? ` (${other})` : ""}` }],
    };
  } catch (e) {
    return { ...fail(e), seen, skipped };
  } finally {
    // Closes the subscription; listening ends with the step.
    void deps.cancel(sub).catch(() => undefined);
  }
}

/* ---------- walking a flow ---------- */

export type RunStatus = "passed" | "failed" | "cancelled";

export interface WalkHooks<T> {
  run: (step: FlowStep) => Promise<T>;
  notRun: (step: FlowStep, why: "skipped" | "cancelled") => T;
  isCancelled: () => boolean;
}

export interface WalkResult<T> {
  /** Every request's outcome, by step id. */
  outcomes: Map<string, T>;
  /** The lane each if block took, by block id. */
  branches: Record<string, "then" | "else">;
  status: RunStatus;
}

/** Requests a parallel block has in flight at once. */
export const PARALLEL_LIMIT = 4;

/**
 * Runs a flow's requests and blocks in order. A request that doesn't pass
 * fails the run; unless it says to continue, everything after it is skipped.
 * An if block reads the response of the request just before it. A parallel
 * block starts every request in it, even after one fails, and the flow moves
 * on when all have finished.
 */
export async function runItems<T extends { state: string; res?: HttpResponse; message?: QueueMessage }>(
  items: FlowItem[],
  hooks: WalkHooks<T>,
): Promise<WalkResult<T>> {
  const outcomes = new Map<string, T>();
  const branches: Record<string, "then" | "else"> = {};
  let failed = false;
  let stopped = false;
  let last: T | undefined;

  const skip = (s: FlowStep) => outcomes.set(s.id, hooks.notRun(s, hooks.isCancelled() ? "cancelled" : "skipped"));
  const settle = (s: FlowStep, o: T) => {
    outcomes.set(s.id, o);
    if (o.state !== "passed") {
      failed = true;
      if (s.onFailure !== "continue" || o.state === "cancelled") stopped = true;
    }
    return o;
  };
  const one = async (s: FlowStep) => {
    if (stopped || hooks.isCancelled()) return void skip(s);
    last = settle(s, await hooks.run(s));
  };

  for (const item of items) {
    if (isStep(item)) {
      await one(item);
      continue;
    }
    if (stopped || hooks.isCancelled()) {
      allSteps([item]).forEach(skip);
      continue;
    }
    if (item.type === "if") {
      const view = last?.res ? toView(last.res) : last?.message ? messageView(last.message) : undefined;
      const taken = view && item.when.filter((c) => c.left.trim()).every((c) => evalCheck(c, view).ok) ? "then" : "else";
      branches[item.id] = taken;
      for (const s of taken === "then" ? item.else : item.then) outcomes.set(s.id, hooks.notRun(s, "skipped"));
      for (const s of taken === "then" ? item.then : item.else) await one(s);
      continue;
    }
    const queue = [...item.steps];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        if (hooks.isCancelled()) skip(s);
        else settle(s, await hooks.run(s));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_LIMIT, queue.length) }, worker));
    // An if block can't read "the" response of several requests.
    last = undefined;
  }
  return { outcomes, branches, status: hooks.isCancelled() ? "cancelled" : failed ? "failed" : "passed" };
}

/* ---------- checking a flow before it runs ---------- */

export interface Issue {
  /** The request or block the issue is about. */
  id: string;
  level: "error" | "warning";
  message: string;
}

export interface ValidateContext {
  /** Values known before the run: environment, secrets, service URLs. */
  src: VarSources;
  envName: string;
  /** The environment's brokers, for queue steps. */
  brokers?: Record<string, Broker>;
  /** A better explanation for a variable with no value, e.g. a service whose port isn't known yet. */
  explain?: (name: string) => string | undefined;
}

/**
 * Problems that would stop a run, found without sending anything: requests
 * with no URL, variables nothing provides in time, and if blocks with no
 * condition or no request before them. Errors block the run; warnings don't.
 */
export function validateFlow(items: FlowItem[], ctx: ValidateContext): Issue[] {
  const issues: Issue[] = [];
  const all = allSteps(items);
  const num = (id: string) => all.findIndex((s) => s.id === id) + 1;
  const extracts = (s: FlowStep) => s.extract.filter((e) => e.key.trim() && e.value.trim()).map((e) => e.key.trim());
  const produced = new Set<string>();
  /** Set only when an if lane runs. */
  const maybe = new Set<string>();

  const check = (s: FlowStep, known: Set<string>, siblings: FlowStep[] = []) => {
    if (s.queue) queueIssues(s, num(s.id), ctx).forEach((i) => issues.push(i));
    else if (!s.url.trim()) issues.push({ id: s.id, level: "error", message: `Request ${num(s.id)} has no URL.` });
    const missing = s.queue ? prepareQueue(s, ctx.src, ctx.brokers ?? {}, false).missing : prepareRequest(s, ctx.src, false).missing;
    // A run opens its listens when it starts; one that needs an extracted value can only open when it's reached.
    const late = s.type === "queue.consume" ? missing.filter((m) => known.has(m) || maybe.has(m)) : [];
    if (late.length)
      issues.push({
        id: s.id,
        level: "warning",
        message: `Step ${num(s.id)} uses ${late.map((m) => `{{${m}}}`).join(", ")} from an earlier step, so it starts listening only when it's reached and can miss a message sent before that.`,
      });
    for (const m of missing) {
      if (known.has(m)) continue;
      if (maybe.has(m)) {
        issues.push({ id: s.id, level: "warning", message: `{{${m}}} comes from a request inside an if block, so it's empty when that lane doesn't run.` });
        continue;
      }
      const sibling = siblings.find((x) => x.id !== s.id && extracts(x).includes(m));
      const later = all.find((x) => extracts(x).includes(m));
      issues.push({
        id: s.id,
        level: "error",
        message: sibling
          ? `{{${m}}} comes from request ${num(sibling.id)}, which is sent at the same time. Move one of them out of the block.`
          : later
            ? `{{${m}}} comes from request ${num(later.id)}, which runs after this one.`
            : (ctx.explain?.(m) ?? `{{${m}}} has no value in “${ctx.envName}”. Add it under Environment.`),
      });
    }
  };

  items.forEach((item, i) => {
    if (isStep(item)) {
      check(item, produced);
      extracts(item).forEach((k) => produced.add(k));
    } else if (item.type === "if") {
      const prev = items[i - 1];
      if (!prev || !isStep(prev) || prev.type === "queue.publish")
        issues.push({
          id: item.id,
          level: "error",
          message:
            "An if block reads the response (or received message) of the step just before it. Put a request or a wait-for-message step above this block.",
        });
      if (!item.when.some((c) => c.left.trim())) issues.push({ id: item.id, level: "error", message: "This if block has no condition yet." });
      if (!item.then.length && !item.else.length) issues.push({ id: item.id, level: "warning", message: "This if block has no requests yet." });
      for (const lane of [item.then, item.else]) {
        const known = new Set(produced);
        for (const s of lane) {
          check(s, known);
          extracts(s).forEach((k) => known.add(k));
        }
      }
      [...item.then, ...item.else].flatMap(extracts).forEach((k) => !produced.has(k) && maybe.add(k));
    } else {
      if (!item.steps.length) issues.push({ id: item.id, level: "warning", message: "This block has no requests yet." });
      item.steps.forEach((s) => check(s, produced, item.steps));
      item.steps.flatMap(extracts).forEach((k) => produced.add(k));
    }
  });
  return issues;
}

/* ---------- what a run record keeps ---------- */

/** Run records keep at most this much of each request and response body. */
export const RECORD_BODY_CAP = 64 * 1024;
const HIDDEN = "••••••";
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;
const SENSITIVE_KEY = /token|secret|passw|api[-_]?key|authorization|cookie|session|jwt|credential|private[-_]?key/i;

const maskAll = (text: string, secrets: string[]) => secrets.filter((v) => v.length >= 4).reduce((t, v) => t.split(v).join(HIDDEN), text);

export function redactHeaders(headers: [string, string][], secrets: string[]): [string, string][] {
  return headers.map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? HIDDEN : maskAll(v, secrets)]);
}

/** Hides secret values and the values of token-like JSON keys, then caps the size. */
export function redactBody(text: string | null | undefined, secrets: string[]): { body: string; truncated: boolean } | undefined {
  if (text == null || text === "") return undefined;
  let out = text;
  try {
    let changed = false;
    const scrub = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(scrub);
      if (!v || typeof v !== "object") return v;
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          if (SENSITIVE_KEY.test(k) && x != null && typeof x !== "object") return ((changed = true), [k, HIDDEN]);
          return [k, scrub(x)];
        }),
      );
    };
    const clean = scrub(JSON.parse(text));
    // Re-serialising can round long integers, so the original text is kept unless something was hidden.
    if (changed) out = JSON.stringify(clean, null, 2);
  } catch {
    /* not JSON: secret values are still masked below */
  }
  out = maskAll(out, secrets);
  return out.length > RECORD_BODY_CAP ? { body: out.slice(0, RECORD_BODY_CAP), truncated: true } : { body: out, truncated: false };
}
