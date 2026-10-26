import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  httpDropJar: (id: string) => invoke<void>("http_drop_jar", { id }),
  auxinList: (root: string) => invoke<AuxinFile[]>("auxin_list", { root }),
  auxinWrite: (root: string, path: string, text: string) => invoke<void>("auxin_write", { root, path, text }),
  auxinDelete: (root: string, path: string) => invoke<void>("auxin_delete", { root, path }),
  auxinWatch: (root: string) => invoke<void>("auxin_watch", { root }),
  auxinListDir: (root: string, path: string) => invoke<string[]>("auxin_list_dir", { root, path }),
  auxinRead: (root: string, path: string) => invoke<string>("auxin_read", { root, path }),
  detectDirections: (root: string, services: { alias: string; path: string; port: number | null }[]) =>
    invoke<{ from: string; to: string; source: "env" | "config" | "code"; evidence: string[] }[]>("detect_directions", { root, services }),
  sampleConnections: (groups: [string, number][], portOwner: Record<number, string>) => invoke<[string, string][]>("sample_connections", { groups, portOwner }),
  filePreview: (path: string) => invoke<[string, number]>("file_preview", { path }),
  onFilesChanged: (cb: (root: string) => void) => listen<string>("auxin://files-changed", (e) => cb(e.payload)),
  onLogs: (cb: (lines: LogEvent[]) => void) => listen<LogEvent[]>("auxin://logs", (e) => cb(e.payload)),
  onStatus: (cb: (s: StatusEvent) => void) => listen<StatusEvent>("auxin://status", (e) => cb(e.payload)),
};
