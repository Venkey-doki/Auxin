import { create } from "zustand";
import { confirm } from "@tauri-apps/plugin-dialog";
import { api, type OtelStatus } from "../lib/api";
import type {
  Config,
  DetectedService,
  Group,
  GroupLayout,
  Runtime,
  Service,
  ServiceOverride,
  View,
  Workspace,
} from "../lib/types";
import { basename, detectPort, hashColor, uid } from "../lib/util";
import { appendLogs, systemLog } from "./logs";

export interface Toast {
  id: string;
  tone: "error" | "info";
  title: string;
  detail?: string;
}

interface State {
  ready: boolean;
  config: Config;
  detected: DetectedService[];
  scanning: boolean;
  scanError: string | null;
  runtime: Record<string, Runtime>;
  view: View;
  toasts: Toast[];
  paletteOpen: boolean;
  sidebarCollapsed: boolean;
  /** The OpenTelemetry receiver, once known. */
  otel: OtelStatus | null;
}

const EMPTY: Config = { version: 1, workspaces: [], activeWorkspaceId: null };

export const useStore = create<State>(() => ({
  ready: false,
  config: EMPTY,
  detected: [],
  scanning: false,
  scanError: null,
  runtime: {},
  view: { type: "overview" },
  toasts: [],
  paletteOpen: false,
  sidebarCollapsed: readPref("auxin.sidebarCollapsed") === "1",
  otel: null,
}));

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const set = useStore.setState;
const get = useStore.getState;

/* ---------- derived ---------- */

export function activeWorkspace(s: State = get()): Workspace | undefined {
  return s.config.workspaces.find((w) => w.id === s.config.activeWorkspaceId);
}

let cacheKey: unknown[] = [];
let cacheVal: Service[] = [];

/** Detection merged with the workspace's overrides; memoised on its inputs. */
export function selectServices(s: State): Service[] {
  const ws = activeWorkspace(s);
  const key = [s.detected, ws?.overrides, ws?.manual, ws?.hidden];
  if (key.every((k, i) => k === cacheKey[i])) return cacheVal;
  cacheKey = key;
  if (!ws) return (cacheVal = []);
  const manual: DetectedService[] = ws.manual
    .filter((m) => !s.detected.some((d) => d.id === m.id))
    .map((m) => ({ id: m.id, name: m.name, path: m.path, kind: "custom", framework: null, suggestions: [], defaultCommand: null, venv: null, portHint: null }));
  cacheVal = [...s.detected, ...manual]
    .filter((d) => !ws.hidden.includes(d.id))
    .map((d, index) => {
      const o: ServiceOverride = ws.overrides[d.id] ?? {};
      return {
        id: d.id,
        index: index + 1,
        name: o.name?.trim() || d.name,
        path: d.path,
        kind: d.kind,
        framework: d.framework,
        command: o.command ?? d.defaultCommand ?? "",
        detectedCommand: d.defaultCommand,
        suggestions: d.suggestions,
        savedCommands: o.savedCommands ?? [],
        cwd: o.cwd?.trim() || d.path,
        env: o.env ?? [],
        venv: d.venv,
        useVenv: o.useVenv ?? true,
        color: o.color ?? hashColor(d.id),
        portHint: d.portHint ?? o.lastPort ?? portFromCommand(o.command ?? d.defaultCommand ?? ""),
        manual: ws.manual.some((m) => m.id === d.id),
        otel: d.otel === true,
        otelEndpoint: d.otelEndpoint === true,
        spanName: d.otelServiceName || o.name?.trim() || d.name,
        // A service that exports somewhere of its own keeps doing so unless you switch this on.
        sendTraces: o.otel ?? (d.otel === true && d.otelEndpoint !== true),
      };
    });
  return cacheVal;
}

export function selectHiddenServices(s: State): DetectedService[] {
  const ws = activeWorkspace(s);
  return ws ? s.detected.filter((d) => ws.hidden.includes(d.id)) : [];
}

function portFromCommand(cmd: string): number | null {
  const m = /(?:--port|-p|PORT=)[\s=]?(\d{2,5})/.exec(cmd);
  return m ? Number(m[1]) : null;
}

export function serviceById(id: string): Service | undefined {
  return selectServices(get()).find((s) => s.id === id);
}

export function isLive(r?: Runtime): boolean {
  return !!r && (r.status === "running" || r.status === "starting" || r.status === "stopping");
}

/** Drops leading timestamps, pids and log levels so the line's message shows. */
function cleanLine(text: string): string {
  let t = text.trim();
  const prefixes = [
    /^\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+(Z|[+-]\d{2}:?\d{2})?\]?\s*/,
    /^\[?\d{2}:\d{2}:\d{2}([.,]\d+)?\]?\s*/,
    /^\[?(INFO|DEBUG|TRACE|WARN|WARNING|ERROR|NOTICE|info|debug|warn|error)\]?:?\s*/,
    /^\[Nest\]\s*\d+\s*-\s*/,
    /^\|\s*/,
    /^-\s+/,
  ];
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of prefixes) {
      const next = t.replace(re, "");
      if (next !== t) {
        t = next;
        changed = true;
      }
    }
  }
  return t;
}

/* ---------- persistence ---------- */

let saveTimer: number | undefined;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    api.saveConfig(JSON.stringify(get().config, null, 2)).catch((e) => toast("error", "Couldn't save settings", String(e)));
  }, 300);
}

export function updateActiveWorkspace(fn: (w: Workspace) => Workspace) {
  const s = get();
  const id = s.config.activeWorkspaceId;
  if (!id) return;
  set({ config: { ...s.config, workspaces: s.config.workspaces.map((w) => (w.id === id ? fn(w) : w)) } });
  persist();
}

/* ---------- toasts ---------- */

export function toast(tone: Toast["tone"], title: string, detail?: string) {
  const t = { id: uid("t"), tone, title, detail };
  set((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  window.setTimeout(() => dismissToast(t.id), tone === "error" ? 8000 : 4000);
}

export function dismissToast(id: string) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/* ---------- boot & workspaces ---------- */

/**
 * Flows used to be sets of services started together; that is what groups do
 * now. Each old flow becomes a group with the same name and services.
 */
function migrateLegacyFlows(config: Config): Config {
  let moved = 0;
  const workspaces = config.workspaces.map((w) => {
    if (!w.flows?.length) return w;
    const groups = [...w.groups];
    for (const f of w.flows) {
      const serviceIds = [...new Set((f.steps ?? []).map((st) => st.serviceId).filter(Boolean))];
      if (!serviceIds.length) continue;
      const taken = groups.some((g) => g.name === f.name);
      groups.push({ id: uid("g"), name: taken ? `${f.name} (flow)` : f.name, serviceIds, layout: "columns" });
      moved++;
    }
    const { flows: _drop, ...rest } = w;
    return { ...rest, groups };
  });
  if (!moved) return config;
  const next = { ...config, workspaces };
  // Persist right away so the notice shows once.
  void api.saveConfig(JSON.stringify(next, null, 2));
  window.setTimeout(() => toast("info", "Flows now chain HTTP requests", `Your ${moved} earlier flow${moved > 1 ? "s are" : " is"} now under Groups, with the same services.`), 600);
  return next;
}

export async function boot() {
  // The receiver starts with the app; a missing one (older backend, browser preview) just means no spans.
  void api
    .otelStatus()
    .then((otel) => set({ otel }))
    .catch(() => undefined);
  try {
    const raw = await api.loadConfig();
    if (raw) {
      const parsed = JSON.parse(raw) as Config;
      if (parsed?.version === 1) set({ config: migrateLegacyFlows(parsed) });
    }
  } catch (e) {
    toast("error", "Settings file was unreadable", "Starting with a fresh configuration.");
  }

  await api.onLogs((events) => {
    const added = appendLogs(events);
    // Keep the last line and any announced port per service.
    const patch: Record<string, Partial<Runtime>> = {};
    for (const e of added) {
      if (e.stream === "system" || !e.plain.trim()) continue;
      const p = (patch[e.id] ??= {});
      const line = cleanLine(e.plain);
      if (line) p.lastLine = line.slice(0, 200);
      const port = detectPort(e.plain);
      if (port) p.port = port;
    }
    if (Object.keys(patch).length) {
      set((s) => {
        const runtime = { ...s.runtime };
        for (const [id, p] of Object.entries(patch)) {
          const prev = runtime[id] ?? { status: "stopped" };
          runtime[id] = { ...prev, ...p, port: prev.port ?? p.port };
        }
        return { runtime };
      });
      // Remember each service's announced port, so {{service}} resolves even while it's stopped.
      const ws = activeWorkspace();
      for (const [id, p] of Object.entries(patch)) {
        if (p.port && ws && ws.overrides[id]?.lastPort !== p.port && get().runtime[id]?.port === p.port) setOverride(id, { lastPort: p.port });
      }
    }
  });

  await api.onStatus((ev) => {
    set((s) => {
      const prev = s.runtime[ev.id] ?? { status: "stopped" };
      const next: Runtime = { ...prev, status: ev.status, pid: ev.pid ?? undefined, code: ev.code };
      if (ev.status === "running") {
        next.startedAt = ev.ts;
        next.error = undefined;
      }
      if (ev.status === "stopped" || ev.status === "exited" || ev.status === "crashed") {
        next.pid = undefined;
        next.port = undefined;
      }
      return { runtime: { ...s.runtime, [ev.id]: next } };
    });
    if (ev.status === "crashed") {
      const svc = serviceById(ev.id);
      toast("error", `${svc?.name ?? basename(ev.id)} crashed`, ev.code != null ? `Exit code ${ev.code}` : "Terminated by a signal");
    }
  });

  // Webview reloads (dev) keep processes alive in Rust; re-adopt them.
  const running = await api.running().catch(() => [] as [string, number][]);
  if (running.length) {
    set((s) => {
      const runtime = { ...s.runtime };
      for (const [id, pid] of running) runtime[id] = { status: "running", pid, startedAt: Date.now() };
      return { runtime };
    });
  }

  set({ ready: true });
  if (activeWorkspace()) await rescan();
}

export async function openWorkspace(root: string) {
  const s = get();
  let ws = s.config.workspaces.find((w) => w.root === root);
  if (!ws) {
    ws = { id: uid("w"), root, name: basename(root), overrides: {}, manual: [], hidden: [], groups: [] };
    set({ config: { ...s.config, workspaces: [...s.config.workspaces, ws] } });
  }
  set((st) => ({ config: { ...st.config, activeWorkspaceId: ws!.id }, view: { type: "overview" }, detected: [] }));
  persist();
  await rescan();
}

export function forgetWorkspace(id: string) {
  set((s) => {
    const workspaces = s.config.workspaces.filter((w) => w.id !== id);
    const active = s.config.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.config.activeWorkspaceId;
    return { config: { ...s.config, workspaces, activeWorkspaceId: active } };
  });
  persist();
  void rescan();
}

export async function rescan() {
  const ws = activeWorkspace();
  if (!ws) return set({ detected: [] });
  set({ scanning: true, scanError: null });
  try {
    const detected = await api.scanWorkspace(ws.root);
    set({ detected, scanning: false });
  } catch (e) {
    set({ scanning: false, scanError: String(e) });
  }
}

/* ---------- services ---------- */

export function setOverride(id: string, patch: Partial<ServiceOverride>) {
  updateActiveWorkspace((w) => ({ ...w, overrides: { ...w.overrides, [id]: { ...w.overrides[id], ...patch } } }));
}

export function resetOverride(id: string) {
  updateActiveWorkspace((w) => {
    // Saved commands survive a reset; everything else returns to detection.
    const overrides = { ...w.overrides };
    const { savedCommands, lastPort } = overrides[id] ?? {};
    if (savedCommands?.length || lastPort) overrides[id] = { savedCommands, lastPort };
    else delete overrides[id];
    return { ...w, overrides };
  });
}

export function hideService(id: string, hidden: boolean) {
  updateActiveWorkspace((w) => ({ ...w, hidden: hidden ? [...w.hidden, id] : w.hidden.filter((h) => h !== id) }));
  if (hidden && get().view.type === "service") set({ view: { type: "overview" } });
}

export async function addManualService(path: string) {
  const detected = await api.inspectFolder(path).catch(() => null);
  updateActiveWorkspace((w) => ({ ...w, manual: [...w.manual.filter((m) => m.id !== path), { id: path, name: basename(path), path }] }));
  if (detected) set((s) => ({ detected: s.detected.some((d) => d.id === detected.id) ? s.detected : [...s.detected, detected] }));
  set({ view: { type: "service", id: path } });
}

export function removeManualService(id: string) {
  updateActiveWorkspace((w) => ({ ...w, manual: w.manual.filter((m) => m.id !== id) }));
  set((s) => ({ detected: s.detected.filter((d) => d.id !== id || !d.path.startsWith(activeWorkspace()?.root ?? "\0")) }));
  set({ view: { type: "overview" } });
}

export async function startService(id: string): Promise<boolean> {
  const svc = serviceById(id);
  if (!svc) return false;
  if (isLive(get().runtime[id])) return true;
  if (!svc.command.trim()) {
    toast("error", `${svc.name} has no start command`, "Open the service and set one under Command.");
    set({ view: { type: "service", id } });
    return false;
  }
  set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], status: "starting", startedAt: Date.now(), code: undefined, error: undefined, port: undefined } } }));
  try {
    const port = svc.sendTraces ? get().otel?.port : null;
    await api.start({ id, command: svc.command, cwd: svc.cwd, env: withOtelEnv(svc.env, svc.spanName, port ?? null), venv: svc.useVenv ? svc.venv : null });
    return true;
  } catch (e) {
    const msg = String(e);
    systemLog(id, `Could not start: ${msg}`);
    set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], status: "crashed", error: msg } } }));
    toast("error", `Couldn't start ${svc.name}`, msg);
    return false;
  }
}

/**
 * Points a service's OpenTelemetry exporter at Auxin's receiver. These are the
 * standard variables every SDK reads; variables set on the service in Auxin win.
 * `name` is the service's own OTEL_SERVICE_NAME when its .env has one, so its
 * spans keep the name it gave itself.
 */
export function withOtelEnv(env: [string, string][], name: string, port: number | null): [string, string][] {
  if (!port) return env;
  const add: [string, string][] = [
    ["OTEL_EXPORTER_OTLP_ENDPOINT", `http://127.0.0.1:${port}`],
    ["OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"],
    ["OTEL_SERVICE_NAME", name],
  ];
  return [...env, ...add.filter(([k]) => !env.some(([x]) => x === k))];
}

/** The workspace service a span's `service.name` belongs to. */
export function serviceForSpan(services: Service[], name: string): Service | undefined {
  const n = name.toLowerCase();
  return services.find((s) => s.spanName.toLowerCase() === n) ?? services.find((s) => s.name.toLowerCase() === n);
}

export async function stopService(id: string) {
  const r = get().runtime[id];
  if (!r || !isLive(r)) return;
  try {
    await api.stop(id);
  } catch (e) {
    // Already gone: settle the UI.
    set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], status: "stopped" } } }));
  }
}

export async function restartService(id: string) {
  if (isLive(get().runtime[id])) {
    await stopService(id);
    await waitFor(() => !isLive(get().runtime[id]), 8000);
  }
  await startService(id);
}

export function stopAll(ids?: string[]) {
  const runtime = get().runtime;
  (ids ?? Object.keys(runtime)).filter((id) => isLive(runtime[id])).forEach((id) => void stopService(id));
}

function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (cond()) return resolve(true);
    const started = Date.now();
    const unsub = useStore.subscribe(() => {
      if (cond()) {
        unsub();
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        unsub();
        resolve(false);
      }
    });
    window.setTimeout(() => {
      unsub();
      resolve(cond());
    }, timeoutMs);
  });
}

/* ---------- navigation ---------- */

export function navigate(view: View) {
  set({ view, paletteOpen: false });
}

export function toggleSidebar() {
  const next = !get().sidebarCollapsed;
  set({ sidebarCollapsed: next });
  try {
    localStorage.setItem("auxin.sidebarCollapsed", next ? "1" : "0");
  } catch {
    /* per-machine convenience only */
  }
}

export function setPalette(open: boolean) {
  set({ paletteOpen: open });
}

/* ---------- groups ---------- */

export function createGroup(name = "New group", serviceIds: string[] = []): string {
  const g: Group = { id: uid("g"), name, serviceIds, layout: "columns" };
  updateActiveWorkspace((w) => ({ ...w, groups: [...w.groups, g] }));
  set({ view: { type: "group", id: g.id } });
  return g.id;
}

export function updateGroup(id: string, patch: Partial<Group>) {
  updateActiveWorkspace((w) => ({ ...w, groups: w.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
}

export function setGroupLayout(id: string, layout: GroupLayout) {
  updateGroup(id, { layout });
}

/** Asks first; returns whether the group was deleted. */
export async function confirmDeleteGroup(id: string): Promise<boolean> {
  const g = activeWorkspace()?.groups.find((x) => x.id === id);
  if (!g) return false;
  const ok = await confirm(`Delete the group “${g.name}”? Its services are not stopped or changed.`, {
    title: "Delete group",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  if (ok) deleteGroup(id);
  return ok;
}

export function deleteGroup(id: string) {
  updateActiveWorkspace((w) => ({ ...w, groups: w.groups.filter((g) => g.id !== id) }));
  const v = get().view;
  if (v.type === "group" && v.id === id) set({ view: { type: "overview" } });
}
