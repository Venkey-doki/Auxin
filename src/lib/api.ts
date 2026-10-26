import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Discovery } from "../map/model";
import type { DetectedService } from "./types";

export interface StartSpec {
  id: string;
  command: string;
  cwd: string;
  env: [string, string][];
  venv: string | null;
}

export interface LogEvent {
  id: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
  ts: number;
}

export interface StatusEvent {
  id: string;
  status: "running" | "stopping" | "stopped" | "exited" | "crashed";
  pid: number | null;
  code: number | null;
  ts: number;
}

export type HttpBody = { kind: "none" } | { kind: "text"; value: string } | { kind: "base64"; value: string } | { kind: "file"; value: string };

export interface HttpRequest {
  id: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: HttpBody;
  timeoutMs?: number;
  followRedirects?: boolean;
  insecureTls?: boolean;
  cookieJar?: string | null;
  /** Project root; a file body must be a path inside it. */
  root?: string | null;
  policy?: NetPolicy;
}

export type QueueBroker = { type: "rabbitmq" | "kafka"; url: string };

/** A message received by a queue.consume step. */
export interface QueueMessage {
  source: string;
  routingKey?: string | null;
  key?: string | null;
  partition?: number | null;
  offset?: number | null;
  headers: [string, string][];
  bodyText: string | null;
  bodyBase64: string | null;
  size: number;
  receivedAt: number;
}

/** A span received from a service's OpenTelemetry SDK. Times are ms since the epoch. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: "unspecified" | "internal" | "server" | "client" | "producer" | "consumer";
  service: string;
  startMs: number;
  durationMs: number;
  status: "unset" | "ok" | "error";
  statusMessage: string | null;
  attributes: [string, string][];
  links: { traceId: string; spanId: string }[];
}

/** The built-in OTLP/HTTP receiver: its port, or why it isn't running. */
export interface OtelStatus {
  port: number | null;
  /** On 4319 because something else (another collector) has 4318. */
  fallback: boolean;
  error: string | null;
  spans: number;
}

/** What `step_exec` takes: one variant per step kind. */
export type StepRequest =
  | ({ kind: "http" } & HttpRequest)
  | { kind: "queue.publish"; id: string; broker: QueueBroker; destination: string; routingKey: string | null; key: string | null; headers: [string, string][]; body: string; timeoutMs?: number; policy?: NetPolicy }
  | { kind: "queue.consume"; id: string; broker: QueueBroker; source: string; binding: string | null; traceIds: string[]; waitMs: number; policy?: NetPolicy };

export type StepResult =
  | ({ kind: "http" } & HttpResponse)
  | { kind: "queue.publish"; ms: number; destination: string; partition: number | null; offset: number | null }
  | { kind: "queue.consume"; messages: QueueMessage[]; skipped: number };

/** An environment's network rules (enforced in Rust): private addresses, and which public hosts. */
export interface NetPolicy {
  allowPrivate: boolean;
  /** Empty means any public host; entries are exact hosts or `*.example.com`. */
  allowHosts: string[];
  /** Named in "blocked" messages. */
  env: string;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  contentType: string | null;
  bodyText: string | null;
  bodyBase64: string | null;
  size: number;
  truncated: boolean;
  fullBodyPath: string | null;
  firstByteMs: number;
  totalMs: number;
}

export interface AuxinFile {
  path: string;
  text: string;
}

export const api = {
  scanWorkspace: (root: string) => invoke<DetectedService[]>("scan_workspace", { root }),
  inspectFolder: (path: string) => invoke<DetectedService | null>("inspect_folder", { path }),
  start: (spec: StartSpec) => invoke<number>("start_service", { spec }),
  stop: (id: string) => invoke<void>("stop_service", { id }),
  sendInput: (id: string, text: string) => invoke<void>("send_input", { id, text }),
  running: () => invoke<[string, number][]>("running_services"),
  checkPort: (port: number) => invoke<boolean>("check_port", { port }),
  loadConfig: () => invoke<string | null>("load_config"),
  saveConfig: (json: string) => invoke<void>("save_config", { json }),
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),
  /** HTTP is the first step kind behind `step_exec`. */
  httpSend: (req: HttpRequest) => invoke<HttpResponse>("step_exec", { req: { kind: "http", ...req } }),
  httpCancel: (id: string) => invoke<boolean>("step_cancel", { id }),
  stepExec: (req: StepRequest) => invoke<StepResult>("step_exec", { req }),
  otelStatus: () => invoke<OtelStatus>("otel_status"),
  /** Spans of these traces, plus traces linked to them (a queue consumer's, say). */
  otelSpans: (traceIds: string[]) => invoke<Span[]>("otel_spans", { traceIds }),
  /** Aborts an in-flight step, and closes a consume subscription with this id. */
  stepCancel: (id: string) => invoke<boolean>("step_cancel", { id }),
  httpDropJar: (id: string) => invoke<void>("http_drop_jar", { id }),
  auxinList: (root: string) => invoke<AuxinFile[]>("auxin_list", { root }),
  auxinWrite: (root: string, path: string, text: string) => invoke<void>("auxin_write", { root, path, text }),
  auxinDelete: (root: string, path: string) => invoke<void>("auxin_delete", { root, path }),
  auxinWatch: (root: string) => invoke<void>("auxin_watch", { root }),
  auxinListDir: (root: string, path: string) => invoke<string[]>("auxin_list_dir", { root, path }),
  auxinRead: (root: string, path: string) => invoke<string>("auxin_read", { root, path }),
  /** Infrastructure and links found in the project's files; code is read only when `codeScan` is on. */
  discoverTopology: (root: string, services: { key: string; path: string; port: number | null }[], codeScan: boolean) =>
    invoke<Discovery>("discover_topology", { root, services, codeScan }),
  sampleConnections: (groups: [string, number][], portOwner: Record<number, string>) => invoke<[string, string][]>("sample_connections", { groups, portOwner }),
  filePreview: (path: string) => invoke<[string, number]>("file_preview", { path }),
  onFilesChanged: (cb: (root: string) => void) => listen<string>("auxin://files-changed", (e) => cb(e.payload)),
  onLogs: (cb: (lines: LogEvent[]) => void) => listen<LogEvent[]>("auxin://logs", (e) => cb(e.payload)),
  onStatus: (cb: (s: StatusEvent) => void) => listen<StatusEvent>("auxin://status", (e) => cb(e.payload)),
};
