/**
 * The flow engine with no React or store access: building a request from a
 * step, sending it (polling, checks, extraction), and walking a flow's steps.
 * `runner.ts` connects it to the UI state, tracing and history. Keeping this
 * pure is what lets later step kinds and control flow be tested on their own.
 */
import type { HttpBody, HttpRequest, HttpResponse } from "../lib/api";
import { evalCheck, extractValue, type CheckResult, type ResponseView } from "./eval";
import type { FlowStep, KV } from "./model";
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

  return { method: step.method, url: url.text, headers: finalHeaders, body, bodyText, missing: [...missing], usedSecrets: [...usedSecrets], requestId: ids?.requestId, traceId: ids?.traceId };
}

/** Replaces the values of the secrets a request used. */
export function mask(text: string, used: Iterable<string>, src: VarSources): string {
  let out = text;
  for (const name of used) {
    const v = src.secrets[name];
    if (v) out = out.split(v).join("••••••");
  }
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
}

export interface HttpStepOptions {
  /** Each try is sent as `${reqId}-${n}`, which is also its cancel id. */
  reqId: string;
  jar: string;
  insecureTls: boolean;
  /** Project root; file bodies are resolved (and confined) under it. */
  root: string | null;
}

export interface HttpStepDeps {
  send: (req: HttpRequest) => Promise<HttpResponse>;
  cancelled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Called before each poll try, and with the response of a try whose condition isn't met yet. */
  onPoll?: (p: { tries: number; res?: HttpResponse }) => void;
  /** Called with each in-flight id so a caller can cancel it. */
  onInflight?: (id: string | null) => void;
}

export function toView(r: HttpResponse): ResponseView {
  return { status: r.status, timeMs: r.totalMs, headers: r.headers, bodyText: r.bodyText };
}

/** Sends a prepared request (polling if configured), then evaluates checks and extracts values. */
export async function runHttpStep(step: FlowStep, req: PreparedRequest, opts: HttpStepOptions, deps: HttpStepDeps): Promise<HttpStepResult> {
  const cancelled = (res?: HttpResponse, tries = 0): HttpStepResult => ({ state: "cancelled", error: "Cancelled.", res, tries, checks: [], extracted: [] });
  const maxTries = step.poll ? Math.max(1, step.poll.maxTries) : 1;
  let res: HttpResponse | undefined;
  let tries = 0;
  let pollUnmet: CheckResult[] = [];

  for (; tries < maxTries; ) {
    if (deps.cancelled()) return cancelled(res, tries);
    tries++;
    if (step.poll) deps.onPoll?.({ tries });
    const id = `${opts.reqId}-${tries}`;
    deps.onInflight?.(id);
    try {
      res = await deps.send({ id, method: req.method, url: req.url, headers: req.headers, body: req.body, timeoutMs: step.timeoutMs, followRedirects: true, insecureTls: opts.insecureTls, cookieJar: opts.jar, root: opts.root });
    } catch (e) {
      deps.onInflight?.(null);
      const msg = String(e);
      if (msg === "Cancelled" || deps.cancelled()) return cancelled(res, tries);
      const port = /:(\d{2,5})\b/.exec(/Couldn't connect to ([^.]+)/.exec(msg)?.[1] ?? "")?.[1];
      return { state: "error", error: msg, refusedPort: port ? Number(port) : undefined, res, tries, checks: [], extracted: [] };
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
        if (deps.cancelled()) return cancelled(res, tries);
        await deps.sleep(Math.min(100, step.poll.everyMs - waited));
      }
    }
  }

  const view = toView(res!);
  const checks = step.checks.filter((c) => c.left.trim()).map((c) => evalCheck(c, view));
  // With no checks of its own, a request fails on an HTTP error status.
  if (!step.checks.some((c) => c.left.trim())) checks.push({ label: "status < 400", ok: res!.status < 400, got: String(res!.status) });
  if (step.poll && pollUnmet.length) checks.unshift({ label: `poll until ${pollUnmet.map((p) => p.label).join(" and ")}`, ok: false, got: `not met after ${tries} tries (${pollUnmet[0].got})` });
  const extracted: KV[] = [];
  const missingExtract: string[] = [];
  for (const e of step.extract.filter((x) => x.key.trim() && x.value.trim())) {
    const v = extractValue(e.value, view);
    if (v === undefined) missingExtract.push(e.key);
    else extracted.push({ key: e.key.trim(), value: v });
  }
  if (missingExtract.length) checks.push({ label: `extract ${missingExtract.join(", ")}`, ok: false, got: "path not found in response" });
  return { state: checks.every((c) => c.ok) ? "passed" : "failed", res, tries, checks, extracted };
}

/* ---------- walking a flow ---------- */

export type RunStatus = "passed" | "failed" | "cancelled";

/**
 * Runs steps in order. After a step that doesn't pass, the rest are skipped;
 * after a cancel, they're marked cancelled. Branches and parallel blocks are
 * meant to extend this walk.
 */
export async function runSequence<T extends { state: string }>(
  steps: FlowStep[],
  run: (step: FlowStep) => Promise<T>,
  notRun: (step: FlowStep, why: "skipped" | "cancelled") => T,
  isCancelled: () => boolean,
): Promise<{ outcomes: T[]; status: RunStatus }> {
  const outcomes: T[] = [];
  let failed = false;
  for (const step of steps) {
    if (isCancelled() || failed) {
      outcomes.push(notRun(step, isCancelled() ? "cancelled" : "skipped"));
      continue;
    }
    const o = await run(step);
    outcomes.push(o);
    if (o.state !== "passed") failed = true;
  }
  return { outcomes, status: isCancelled() ? "cancelled" : failed ? "failed" : "passed" };
}
