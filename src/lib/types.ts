export type ProcStatus = "stopped" | "starting" | "running" | "stopping" | "exited" | "crashed";

export interface CommandSuggestion {
  label: string;
  command: string;
  source: string;
}

/** What the Rust scanner reports for a folder. */
export interface DetectedService {
  id: string;
  name: string;
  path: string;
  kind: string;
  framework: string | null;
  suggestions: CommandSuggestion[];
  defaultCommand: string | null;
  venv: string | null;
  portHint: number | null;
  /** Its dependencies include an OpenTelemetry SDK. */
  otel?: boolean;
  /** Its own `.env` points the OTel exporter somewhere. */
  otelEndpoint?: boolean;
  /** `OTEL_SERVICE_NAME` from its own `.env`. */
  otelServiceName?: string | null;
}

/** User edits layered over detection; keyed by service id (its path). */
export interface ServiceOverride {
  name?: string;
  command?: string;
  /** Commands the user saved for this service, offered alongside detected ones. */
  savedCommands?: string[];
  cwd?: string;
  env?: [string, string][];
  useVenv?: boolean;
  color?: number;
  /** Port the service last announced in its logs; used while it's stopped. */
  lastPort?: number;
  /** Send its OpenTelemetry traces to Auxin (defaults to on when it uses an SDK). */
  otel?: boolean;
}

export interface ManualService {
  id: string;
  name: string;
  path: string;
}

export type GroupLayout = "columns" | "grid" | "merged";

export interface Group {
  id: string;
  name: string;
  serviceIds: string[];
  layout: GroupLayout;
}

/**
 * Before 2026-10-24 a "flow" was a set of services started in order. Those are
 * migrated to groups on load; this shape exists only to read old configs.
 */
export interface LegacyFlow {
  id: string;
  name: string;
  steps: { serviceId: string }[];
}

export interface Workspace {
  id: string;
  root: string;
  name: string;
  overrides: Record<string, ServiceOverride>;
  manual: ManualService[];
  hidden: string[];
  groups: Group[];
  /** Legacy launch-set flows, migrated to groups on boot. */
  flows?: LegacyFlow[];
  /** Selected environment for request flows (`.auxin/env/<name>.json`). */
  activeEnv?: string;
  /** You allowed the map to read source code here (off until then; per machine, never in the repo). */
  codeScan?: boolean;
}

export interface Config {
  version: 1;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

/** A service as the UI sees it: detection merged with overrides. */
export interface Service {
  id: string;
  index: number;
  name: string;
  path: string;
  kind: string;
  framework: string | null;
  command: string;
  detectedCommand: string | null;
  suggestions: CommandSuggestion[];
  savedCommands: string[];
  cwd: string;
  env: [string, string][];
  venv: string | null;
  useVenv: boolean;
  color: number;
  portHint: number | null;
  manual: boolean;
  /** Uses an OpenTelemetry SDK (detected). */
  otel: boolean;
  /** Its own `.env` already points its exporter somewhere, so Auxin leaves it alone unless told to. */
  otelEndpoint: boolean;
  /** The name its spans carry: its own `OTEL_SERVICE_NAME`, else its name in Auxin. */
  spanName: string;
  /** Started with its trace exporter pointed at Auxin. */
  sendTraces: boolean;
}

export interface Runtime {
  status: ProcStatus;
  pid?: number;
  code?: number | null;
  startedAt?: number;
  port?: number;
  lastLine?: string;
  error?: string;
}

export type View =
  | { type: "overview" }
  | { type: "service"; id: string }
  | { type: "group"; id: string }
  | { type: "flow"; id: string }
  | { type: "map" };

