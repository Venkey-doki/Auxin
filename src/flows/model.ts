/**
 * Flow files (`.auxin/flows/*.flow.json`) and environments (`.auxin/env/*.json`),
 * per docs/flows-spec.md §2. In memory, headers and form fields are editable
 * rows; on disk they are ordered objects. Fields this version doesn't know are
 * carried through untouched.
 *
 * Files are written as version 2, where each step names its kind
 * (`type: "http"`) and keeps the request under `http`, and `poll` is `wait`.
 * Version 1 files (flat steps) still load; they become version 2 on save.
 *
 * `steps` is a list of requests and blocks: an `if` block runs one of two
 * lanes of requests depending on the previous response; a `parallel` block
 * sends its requests at once. Blocks hold requests only, never other blocks.
 *
 * A step is an HTTP request (`type: "http"`), or a message: `queue.publish`
 * sends one to a RabbitMQ exchange or Kafka topic, `queue.consume` waits for one
 * to arrive there. Queue steps keep their settings under `queue`.
 */

export interface KV {
  key: string;
  value: string;
}

export type BodyKind = "none" | "json" | "text" | "form" | "file";

export interface StepBody {
  kind: BodyKind;
  /** JSON or text source as the user typed it. */
  text: string;
  form: KV[];
  /** Relative to the workspace root; files outside it are never sent. */
  file: string;
}

export type CheckOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "contains" | "matches" | "exists" | "!exists" | "length ==";
export const CHECK_OPS: CheckOp[] = ["==", "!=", "<", "<=", ">", ">=", "contains", "matches", "exists", "!exists", "length =="];

export interface Check {
  /** `status`, `time`, `header.x`, `body.a.b[0]`… */
  left: string;
  op: CheckOp;
  /** The expected value as typed: JSON (`200`, `"done"`, `true`) or bare text. */
  right: string;
}

export interface Poll {
  until: Check[];
  everyMs: number;
  maxTries: number;
}

/** Re-send a request that fails: on errors (no response, or a 5xx) or on any failure (checks too). */
export interface Retry {
  max: number;
  backoffMs: number;
  on: "errors" | "any";
}

export type OnFailure = "stop" | "continue";

export type StepType = "http" | "queue.publish" | "queue.consume";

/**
 * A queue step. `destination` is a RabbitMQ exchange ("" is the default
 * exchange) or a Kafka topic. Publish: `routingKey` (RabbitMQ) or `key` (Kafka),
 * headers and body, with {{variables}}. Consume: `routingKey` is the binding
 * pattern (RabbitMQ), and the step waits up to `timeoutMs` for a message that
 * passes the step's checks, optionally only messages carrying this run's trace ids.
 */
export interface QueueSpec {
  /** A broker named in the environment (`brokers`). */
  broker: string;
  destination: string;
  routingKey: string;
  key: string;
  headers: KV[];
  body: string;
  matchRun: boolean;
  timeoutMs: number;
}

export interface FlowStep {
  id: string;
  type: StepType;
  name: string;
  method: string;
  url: string;
  headers: KV[];
  body: StepBody;
  timeoutMs: number;
  /** variable name → path, e.g. jobId → body.jobId */
  extract: KV[];
  checks: Check[];
  poll: Poll | null;
  retry: Retry | null;
  /** After this request fails: stop the flow (default) or carry on. */
  onFailure: OnFailure;
  /** Queue steps only. */
  queue: QueueSpec | null;
  /** Fields this version doesn't know, preserved. */
  rest: Record<string, unknown>;
  /** The same, inside `http`, its `body`, `wait` and `queue`. */
  restIn?: Partial<Record<"http" | "body" | "wait" | "queue", Record<string, unknown>>>;
}

/** Runs `then` when every condition holds on the previous response, `else` otherwise. */
export interface IfBlock {
  id: string;
  type: "if";
  name: string;
  when: Check[];
  then: FlowStep[];
  else: FlowStep[];
  rest: Record<string, unknown>;
}

/** Sends its requests at the same time; the flow continues when all have finished. */
export interface ParallelBlock {
  id: string;
  type: "parallel";
  name: string;
  steps: FlowStep[];
  rest: Record<string, unknown>;
}

export type FlowBlock = IfBlock | ParallelBlock;
export type FlowItem = FlowStep | FlowBlock;
/** Where requests live: the top level, or one lane of a block (`steps` for a parallel block). */
export type Lane = { block: null } | { block: string; lane: "then" | "else" | "steps" };

export interface FlowService {
  /** Folder path relative to the workspace root. */
  ref: string;
  /** Name used in {{variables}} and on the canvas. */
  alias: string;
  x?: number;
  y?: number;
}

/**
 * Links between services used to be stored in each flow (`directions`,
 * `dismissed`, by alias). They now live on the project map; a file that still
 * has them hands them over once, and they aren't written back.
 */
export interface LegacyLinks {
  /** Links that were confirmed or added by hand. */
  kept: { from: string; to: string }[];
  dismissed: { from: string; to: string }[];
}

export interface FlowDoc {
  /** Path inside `.auxin/`, e.g. `flows/model-end-to-end.flow.json`. */
  path: string;
  name: string;
  steps: FlowItem[];
  services: FlowService[];
  /** Set only when the file still had links in it (see LegacyLinks). */
  legacyLinks?: LegacyLinks;
  injectHeaders: boolean;
  graceMs: number;
  /** Top-level fields this version doesn't know, preserved. */
  rest: Record<string, unknown>;
}

/** Which addresses an environment's requests may reach; enforced in the backend. */
export interface NetworkRules {
  /** Localhost, LAN and other private addresses. Cloud metadata addresses are always blocked. */
  allowPrivate: boolean;
  /** Public hosts allowed; empty allows any. Exact hosts or `*.example.com`. */
  allowHosts: string[];
}

export const DEFAULT_NETWORK: NetworkRules = { allowPrivate: true, allowHosts: [] };

/** A message broker queue steps can use. `url` may hold {{secret}} variables. */
export interface Broker {
  type: "rabbitmq" | "kafka";
  /** RabbitMQ: `amqp://user:pass@host:5672/vhost`. Kafka: `host:9092`, comma-separated for several. */
  url: string;
}

export interface EnvDoc {
  name: string;
  vars: Record<string, string>;
  baseUrls: Record<string, string>;
  insecureTls: boolean;
  network: NetworkRules;
  brokers: Record<string, Broker>;
  /** From `<name>.secret.json`, never written to the shared file. */
  secrets: Record<string, string>;
}

/**
 * Where the flow schema is written in each project, relative to `.auxin/`. Flow
 * files point at it relatively, so editors can check them offline.
 */
export const FLOW_SCHEMA_PATH = "schema/flow-2.json";

const FLOW_KEYS = ["$schema", "version", "name", "steps", "trace", "services", "directions", "dismissed"];
const STEP_KEYS = ["id", "type", "name", "http", "queue", "method", "url", "headers", "body", "timeoutMs", "extract", "checks", "wait", "poll", "retry", "onFailure"];
const BLOCK_KEYS = ["id", "type", "name", "when", "then", "else", "steps"];

export const isStep = (i: FlowItem): i is FlowStep => i.type !== "if" && i.type !== "parallel";
export const isQueue = (s: FlowStep) => s.type !== "http";

/** Every request in run order (an if block's `then` lane before its `else` lane). */
export function allSteps(items: FlowItem[]): FlowStep[] {
  return items.flatMap((i) => (isStep(i) ? [i] : i.type === "if" ? [...i.then, ...i.else] : i.steps));
}

/** Applies `fn` to every request, wherever it sits. */
export function mapSteps(items: FlowItem[], fn: (s: FlowStep) => FlowStep): FlowItem[] {
  return items.map((i) => (isStep(i) ? fn(i) : i.type === "if" ? { ...i, then: i.then.map(fn), else: i.else.map(fn) } : { ...i, steps: i.steps.map(fn) }));
}

/** Removes a request or a block by id. */
export function removeItem(items: FlowItem[], id: string): FlowItem[] {
  const keep = (s: FlowStep) => s.id !== id;
  return items
    .filter((i) => i.id !== id)
    .map((i) => (i.type === "if" ? { ...i, then: i.then.filter(keep), else: i.else.filter(keep) } : i.type === "parallel" ? { ...i, steps: i.steps.filter(keep) } : i));
}

/** Appends `step` to the end of a lane. */
export function addToLane(items: FlowItem[], lane: Lane, step: FlowStep): FlowItem[] {
  if (lane.block == null) return [...items, step];
  return items.map((i) => {
    if (i.id !== lane.block || isStep(i)) return i;
    if (i.type === "parallel") return { ...i, steps: [...i.steps, step] };
    return lane.lane === "else" ? { ...i, else: [...i.else, step] } : { ...i, then: [...i.then, step] };
  });
}

/**
 * Moves a request or block next to another one (`before` / `after` its id) or
 * to the end of a lane. Blocks move only at the top level, since they don't nest.
 */
export function moveItem(items: FlowItem[], id: string, to: { before: string } | { after: string } | { lane: Lane }): FlowItem[] {
  const target = "before" in to ? to.before : "after" in to ? to.after : null;
  if (target === id) return items;
  const moving = items.find((i) => i.id === id) ?? allSteps(items).find((s) => s.id === id);
  if (!moving) return items;
  const toTop = target != null ? items.some((i) => i.id === target) : "lane" in to && to.lane.block == null;
  if (!isStep(moving) && !toTop) return items;
  const rest = removeItem(items, id);
  if ("lane" in to) return addToLane(rest, to.lane, moving as FlowStep);
  const insert = <T extends FlowItem>(list: T[]): T[] => {
    const at = list.findIndex((x) => x.id === target);
    if (at < 0) return list;
    const i = "after" in to ? at + 1 : at;
    return [...list.slice(0, i), moving as T, ...list.slice(i)];
  };
  if (toTop) return insert(rest);
  return rest.map((i) => (i.type === "if" ? { ...i, then: insert(i.then), else: insert(i.else) } : i.type === "parallel" ? { ...i, steps: insert(i.steps) } : i));
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "flow"
  );
}

export function newStepId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** Absolute or `..` paths; the backend refuses to send these (and symlinks out). */
export function outsideWorkspace(file: string): boolean {
  return file.startsWith("/") || file.split("/").includes("..");
}

export function emptyBody(): StepBody {
  return { kind: "none", text: "", form: [], file: "" };
}

export function blankStep(n: number, url = ""): FlowStep {
  return { id: newStepId(), type: "http", name: `Request ${n}`, method: "GET", url, headers: [], body: emptyBody(), timeoutMs: 30_000, extract: [], checks: [], poll: null, retry: null, onFailure: "stop", queue: null, rest: {} };
}

export function blankQueueStep(type: "queue.publish" | "queue.consume", broker = ""): FlowStep {
  return {
    ...blankStep(0),
    type,
    name: type === "queue.publish" ? "Publish message" : "Wait for message",
    queue: { broker, destination: "", routingKey: type === "queue.consume" ? "#" : "", key: "", headers: [], body: type === "queue.publish" ? "{}" : "", matchRun: false, timeoutMs: 15_000 },
  };
}

export function blankBlock(type: FlowBlock["type"]): FlowBlock {
  return type === "if"
    ? { id: newStepId(), type, name: "If", when: [{ left: "status", op: "==", right: "200" }], then: [], else: [], rest: {} }
    : { id: newStepId(), type, name: "At the same time", steps: [], rest: {} };
}

/** Typed text → JSON value: `200` → 200, `"done"` → "done", `done` → "done". */
export function parseRight(text: string): unknown {
  const t = text.trim();
  if (!t) return "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** JSON value → editable text (strings keep their quotes so `"200"` ≠ `200`). */
export function rightText(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v);
}

function parseChecks(raw: unknown): Check[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({ left: String(c.left ?? ""), op: (CHECK_OPS.includes(c.op as CheckOp) ? c.op : "==") as CheckOp, right: c.op === "exists" || c.op === "!exists" ? "" : rightText(c.right) }));
}

const checkOut = (c: Check) => (c.op === "exists" || c.op === "!exists" ? { left: c.left, op: c.op } : { left: c.left, op: c.op, right: parseRight(c.right) });

const toRows = (o: unknown): KV[] => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o as Record<string, unknown>).map(([key, v]) => ({ key, value: String(v ?? "") })) : []);

const toObject = (rows: KV[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value;
  return out;
};

const pick = (o: Record<string, unknown>, skip: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !skip.includes(k)));

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Unknown keys of each nested object, leaving out empty ones. */
function restOf(parts: [key: "http" | "body" | "wait" | "queue", value: unknown, known: string[]][]): Pick<FlowStep, "restIn"> {
  const out: NonNullable<FlowStep["restIn"]> = {};
  for (const [key, value, known] of parts) {
    const o = asObject(value);
    const extra = o ? pick(o, known) : {};
    if (Object.keys(extra).length) out[key] = extra;
  }
  return Object.keys(out).length ? { restIn: out } : {};
}

const HTTP_KEYS = ["method", "url", "headers", "body", "timeoutMs"];
const BODY_KEYS = ["json", "jsonText", "text", "form", "file"];
const WAIT_KEYS = ["until", "everyMs", "maxTries"];
const QUEUE_KEYS = ["broker", "destination", "routingKey", "key", "headers", "body", "matchRun", "timeoutMs"];

function parseBody(b: unknown): StepBody {
  const body = emptyBody();
  if (!b || typeof b !== "object") return body;
  const o = b as Record<string, unknown>;
  if ("json" in o) return { ...body, kind: "json", text: JSON.stringify(o.json, null, 2) };
  if ("text" in o) return { ...body, kind: "text", text: String(o.text ?? "") };
  if ("form" in o) return { ...body, kind: "form", form: toRows(o.form) };
  if ("file" in o) return { ...body, kind: "file", file: String(o.file ?? "") };
  return body;
}

/**
 * Serialised body. Invalid JSON is not written (the caller keeps the last valid
 * body on disk and shows the error), so a typo never corrupts the file.
 */
export function serializeBody(b: StepBody): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (b.kind) {
    case "none":
      return { ok: true, value: null };
    case "text":
      return { ok: true, value: { text: b.text } };
    case "form":
      return { ok: true, value: { form: toObject(b.form) } };
    case "file":
      return { ok: true, value: { file: b.file } };
    case "json": {
      // Empty stays empty (a stored `null` would come back as a literal "null" body).
      if (!b.text.trim()) return { ok: true, value: { jsonText: "" } };
      // Variables in JSON bodies are usually unquoted placeholders like {{count}};
      // swap them for a number so we can validate the rest of the document.
      try {
        JSON.parse(b.text.replace(/\{\{[^}]+\}\}/g, "0"));
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      try {
        const parsed = JSON.parse(b.text);
        // Integers beyond 2^53 (long ids) would be rounded by a parse/print round trip; keep the source.
        if ([...b.text.matchAll(/(?<![\w."])-?\d{16,}(?![\w."])/g)].some((m) => !Number.isSafeInteger(Number(m[0])))) return { ok: true, value: { jsonText: b.text } };
        return { ok: true, value: { json: parsed } };
      } catch {
        // Contains unquoted {{vars}}: keep the source text so it round-trips.
        return { ok: true, value: { jsonText: b.text } };
      }
    }
  }
}

export function parseFlow(path: string, text: string): FlowDoc {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const trace = (raw.trace ?? {}) as Record<string, unknown>;
  return {
    path,
    name: String(raw.name ?? path.replace(/^flows\//, "").replace(/\.flow\.json$/, "")),
    injectHeaders: trace.injectHeaders !== false,
    graceMs: typeof trace.graceMs === "number" ? trace.graceMs : 1500,
    rest: pick(raw, FLOW_KEYS),
    services: (Array.isArray(raw.services) ? raw.services : [])
      .filter((x: Record<string, unknown>) => x && typeof x.ref === "string")
      .map((x: Record<string, unknown>) => ({ ref: String(x.ref), alias: String(x.alias ?? String(x.ref).split("/").pop()), ...(typeof x.x === "number" ? { x: x.x } : {}), ...(typeof x.y === "number" ? { y: x.y } : {}) })),
    ...legacyLinks(raw),
    steps: objects(raw.steps).map(parseItem),
  };
}

const objects = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

function legacyLinks(raw: Record<string, unknown>): { legacyLinks?: LegacyLinks } {
  const pairs = (v: unknown) => objects(v).filter((d) => typeof d.from === "string" && typeof d.to === "string");
  const kept = pairs(raw.directions)
    .filter((d) => d.confirmed !== false)
    .map((d) => ({ from: String(d.from), to: String(d.to) }));
  const dismissed = pairs(raw.dismissed).map((d) => ({ from: String(d.from), to: String(d.to) }));
  return kept.length || dismissed.length ? { legacyLinks: { kept, dismissed } } : {};
}

function parseItem(raw: Record<string, unknown>): FlowItem {
  const base = { id: String(raw.id ?? newStepId()), rest: pick(raw, BLOCK_KEYS) };
  if (raw.type === "if") return { ...base, type: "if", name: String(raw.name ?? "If"), when: parseChecks(raw.when), then: objects(raw.then).map(parseStep), else: objects(raw.else).map(parseStep) };
  if (raw.type === "parallel") return { ...base, type: "parallel", name: String(raw.name ?? "At the same time"), steps: objects(raw.steps).map(parseStep) };
  return parseStep(raw);
}

function parseStep(raw: Record<string, unknown>): FlowStep {
  return raw.type === "queue.publish" || raw.type === "queue.consume" ? parseQueue(raw, raw.type) : parseHttp(raw);
}

function parseRetry(r: unknown): Retry | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  return { max: Math.min(5, Math.max(1, Math.round(Number(o.max)) || 1)), backoffMs: Math.max(0, Number(o.backoffMs) || 500), on: o.on === "any" ? "any" : "errors" };
}

function parseHttp(step: Record<string, unknown>): FlowStep {
  // v2 keeps the request under `http`; v1 has it on the step itself.
  const req = step.http && typeof step.http === "object" ? (step.http as Record<string, unknown>) : step;
  const s: Record<string, unknown> = { ...step, ...req, poll: step.wait ?? step.poll };
  const jsonText = s.body && typeof s.body === "object" && "jsonText" in (s.body as object) ? String((s.body as Record<string, unknown>).jsonText) : null;
  return {
    id: String(s.id ?? newStepId()),
    type: "http",
    name: String(s.name ?? "Request"),
    method: String(s.method ?? "GET").toUpperCase(),
    url: String(s.url ?? ""),
    headers: toRows(s.headers),
    body: jsonText != null ? { ...emptyBody(), kind: "json" as const, text: jsonText } : parseBody(s.body),
    timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : 30_000,
    extract: toRows(s.extract),
    checks: parseChecks(s.checks),
    poll:
      s.poll && typeof s.poll === "object"
        ? {
            until: parseChecks((s.poll as Record<string, unknown>).until),
            everyMs: Number((s.poll as Record<string, unknown>).everyMs) || 1000,
            maxTries: Number((s.poll as Record<string, unknown>).maxTries) || 30,
          }
        : null,
    retry: parseRetry(step.retry),
    onFailure: step.onFailure === "continue" ? "continue" : "stop",
    queue: null,
    rest: pick(step, STEP_KEYS),
    // v1 steps keep the request on the step, so their unknown fields are already in `rest`.
    ...restOf([
      ["http", req === step ? null : req, HTTP_KEYS],
      ["body", s.body, BODY_KEYS],
      ["wait", s.poll, WAIT_KEYS],
    ]),
  };
}

function parseQueue(step: Record<string, unknown>, type: "queue.publish" | "queue.consume"): FlowStep {
  const q = (step.queue && typeof step.queue === "object" ? step.queue : {}) as Record<string, unknown>;
  const base = blankQueueStep(type);
  return {
    ...base,
    id: String(step.id ?? base.id),
    name: String(step.name ?? base.name),
    extract: toRows(step.extract),
    checks: parseChecks(step.checks),
    onFailure: step.onFailure === "continue" ? "continue" : "stop",
    queue: {
      broker: String(q.broker ?? ""),
      destination: String(q.destination ?? ""),
      routingKey: String(q.routingKey ?? (type === "queue.consume" ? "#" : "")),
      key: String(q.key ?? ""),
      headers: toRows(q.headers),
      body: typeof q.body === "string" ? q.body : q.body === undefined ? "" : JSON.stringify(q.body, null, 2),
      matchRun: q.matchRun === true,
      timeoutMs: typeof q.timeoutMs === "number" ? q.timeoutMs : 15_000,
    },
    rest: pick(step, STEP_KEYS),
    ...restOf([["queue", q, QUEUE_KEYS]]),
  };
}

/** `previous` supplies the last valid body for steps whose JSON doesn't parse yet. */
export function serializeFlow(doc: FlowDoc, previous?: FlowDoc): { text: string; invalid: string[] } {
  const invalid: string[] = [];
  const prevSteps = previous ? allSteps(previous.steps) : [];
  const stepOut = (s: FlowStep) => {
    if (s.queue) {
      const q = s.queue;
      return {
        id: s.id,
        type: s.type,
        name: s.name,
        queue: {
          broker: q.broker,
          destination: q.destination,
          ...(q.routingKey ? { routingKey: q.routingKey } : {}),
          ...(s.type === "queue.publish" ? { ...(q.key ? { key: q.key } : {}), headers: toObject(q.headers), body: q.body } : { matchRun: q.matchRun, timeoutMs: q.timeoutMs }),
          ...s.restIn?.queue,
        },
        ...(s.type === "queue.consume" ? { extract: toObject(s.extract), checks: s.checks.filter((c) => c.left.trim()).map(checkOut) } : {}),
        ...(s.onFailure === "continue" ? { onFailure: "continue" } : {}),
        ...s.rest,
      };
    }
    let body = serializeBody(s.body);
    if (!body.ok) {
      invalid.push(s.id);
      const prev = prevSteps.find((p) => p.id === s.id);
      body = prev ? serializeBody(prev.body) : { ok: true, value: null };
      if (!body.ok) body = { ok: true, value: null };
    }
    return {
      id: s.id,
      type: "http",
      name: s.name,
      http: {
        method: s.method,
        url: s.url,
        headers: toObject(s.headers),
        body: asObject(body.value) ? { ...(body.value as object), ...s.restIn?.body } : body.value,
        timeoutMs: s.timeoutMs,
        ...s.restIn?.http,
      },
      extract: toObject(s.extract),
      checks: s.checks.filter((c) => c.left.trim()).map(checkOut),
      ...(s.poll ? { wait: { until: s.poll.until.filter((c) => c.left.trim()).map(checkOut), everyMs: s.poll.everyMs, maxTries: s.poll.maxTries, ...s.restIn?.wait } } : {}),
      ...(s.retry ? { retry: s.retry } : {}),
      ...(s.onFailure === "continue" ? { onFailure: "continue" } : {}),
      ...s.rest,
    };
  };
  const steps = doc.steps.map((i) =>
    isStep(i)
      ? stepOut(i)
      : i.type === "if"
        ? { id: i.id, type: "if", name: i.name, when: i.when.filter((c) => c.left.trim()).map(checkOut), then: i.then.map(stepOut), else: i.else.map(stepOut), ...i.rest }
        : { id: i.id, type: "parallel", name: i.name, steps: i.steps.map(stepOut), ...i.rest },
  );
  const out = {
    $schema: `../${FLOW_SCHEMA_PATH}`,
    version: 2,
    name: doc.name,
    ...doc.rest,
    services: doc.services,
    trace: { injectHeaders: doc.injectHeaders, graceMs: doc.graceMs },
    steps,
  };
  return { text: JSON.stringify(out, null, 2) + "\n", invalid };
}

export function newFlow(path: string, name: string): FlowDoc {
  return { path, name, steps: [], services: [], injectHeaders: true, graceMs: 1500, rest: {} };
}

export function parseEnv(name: string, shared?: string, secret?: string): EnvDoc {
  const s = shared ? (JSON.parse(shared) as Record<string, unknown>) : {};
  const x = secret ? (JSON.parse(secret) as Record<string, unknown>) : {};
  const str = (o: unknown) => Object.fromEntries(Object.entries((o as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v ?? "")]));
  const n = (s.network ?? {}) as Record<string, unknown>;
  const network = { allowPrivate: n.allowPrivate !== false, allowHosts: Array.isArray(n.allowHosts) ? n.allowHosts.map(String).filter((h) => h.trim()) : [] };
  const brokers: Record<string, Broker> = {};
  for (const [k, v] of Object.entries((s.brokers ?? {}) as Record<string, Record<string, unknown>>)) {
    if (v && typeof v.url === "string") brokers[k] = { type: v.type === "kafka" ? "kafka" : "rabbitmq", url: v.url };
  }
  return { name, vars: str(s.vars), baseUrls: str(s.baseUrls), insecureTls: s.insecureTls === true, network, brokers, secrets: str(x.vars) };
}

export function serializeEnv(env: EnvDoc): { shared: string; secret: string } {
  return {
    shared:
      JSON.stringify(
        {
          vars: env.vars,
          baseUrls: env.baseUrls,
          ...(env.insecureTls ? { insecureTls: true } : {}),
          ...(!env.network.allowPrivate || env.network.allowHosts.length ? { network: env.network } : {}),
          ...(Object.keys(env.brokers).length ? { brokers: env.brokers } : {}),
        },
        null,
        2,
      ) + "\n",
    secret: JSON.stringify({ vars: env.secrets }, null, 2) + "\n",
  };
}
