/**
 * Flows state: the workspace's `.auxin/` files (flows, environments, secrets),
 * kept in sync with disk, plus the latest response per request.
 */
import { confirm } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { api } from "../lib/api";
import { activeWorkspace, navigate, selectServices, toast, updateActiveWorkspace, useStore } from "../state/store";
import { allSteps, mapSteps, newFlow, parseEnv, parseFlow, serializeEnv, serializeFlow, slugify, type EnvDoc, type FlowDoc, type FlowStep } from "./model";
import type { FlowRunState, StepOutcome } from "./runner";
import type { VarSources } from "./vars";
import { loadTopology } from "../map/store";

interface FlowsState {
  root: string | null;
  loaded: boolean;
  flows: Record<string, FlowDoc>;
  /** Files that exist but don't parse; shown so they aren't silently ignored. */
  broken: Record<string, string>;
  envs: Record<string, EnvDoc>;
  /** `rk(path, step)` of requests whose JSON body is currently invalid → message. */
  invalid: Record<string, string>;
  /** Latest outcome per step id. */
  responses: Record<string, StepOutcome>;
  /** Latest run per flow path. */
  runs: Record<string, FlowRunState>;
  /** Values extracted by the latest run or sends, per flow path. */
  extracted: Record<string, Record<string, string>>;
}

export const useFlows = create<FlowsState>(() => ({ root: null, loaded: false, flows: {}, broken: {}, envs: {}, invalid: {}, responses: {}, runs: {}, extracted: {} }));
const set = useFlows.setState;
const get = useFlows.getState;

/** Text we last wrote per path, so our own writes don't bounce back as "external" changes. */
const lastWritten = new Map<string, string>();
/** Last version of each flow that serialised cleanly. */
const lastValid = new Map<string, FlowDoc>();
const saveTimers = new Map<string, number>();
/** Paths with a save scheduled or in flight; a reload never replaces these. */
const pending = new Set<string>();
/** Writes in flight per path, so an older write finishing doesn't clear `pending` early. */
const inflightWrites = new Map<string, number>();

/** What a workspace keeps while another is open: its flows, environments and results. */
export type Slice = Pick<FlowsState, "flows" | "broken" | "envs" | "invalid" | "responses" | "runs" | "extracted">;
const SLICE_KEYS = ["flows", "broken", "envs", "invalid", "responses", "runs", "extracted"] as const;
const emptySlice = (): Slice => ({ flows: {}, broken: {}, envs: {}, invalid: {}, responses: {}, runs: {}, extracted: {} });
const pick = (s: FlowsState): Slice => Object.fromEntries(SLICE_KEYS.map((k) => [k, s[k]])) as Slice;

/** Workspaces switched away from, with their bookkeeping, so switching back finds everything as it was. */
const parked = new Map<string, { slice: Slice; lastWritten: Map<string, string>; lastValid: Map<string, FlowDoc> }>();

/** A workspace's state, whether it's the open one or parked. */
export function sliceOf(root: string): Slice | undefined {
  return get().root === root ? pick(get()) : parked.get(root)?.slice;
}

/**
 * Updates a workspace's state wherever it is. A run keeps writing here after
 * you switch to another workspace, so its results are there when you come back.
 */
export function updateSlice(root: string, fn: (s: Slice) => Partial<Slice>) {
  if (get().root === root) return set((s) => fn(pick(s)));
  const p = parked.get(root);
  if (p) p.slice = { ...p.slice, ...fn(p.slice) };
}

/** Key for per-request state: step ids are only unique within one flow file. */
export function rk(path: string, stepId: string): string {
  return `${path}#${stepId}`;
}

/* ---------- loading & watching ---------- */

let watchUnlisten: (() => void) | null = null;
let reloadTimer: number | undefined;

export async function syncWorkspace(root: string | null) {
  if (get().root === root && get().loaded) return;
  const prev = get().root;
  if (prev && prev !== root) {
    // Edits waiting to be saved belong to the workspace being left: save them now, to it.
    for (const path of [...saveTimers.keys()]) {
      window.clearTimeout(saveTimers.get(path));
      saveTimers.delete(path);
      saveNow(path);
    }
    parked.set(prev, { slice: pick(get()), lastWritten: new Map(lastWritten), lastValid: new Map(lastValid) });
  }
  const back = root ? parked.get(root) : undefined;
  if (root) parked.delete(root);
  set({ root, loaded: false, ...(back?.slice ?? emptySlice()) });
  lastWritten.clear();
  lastValid.clear();
  back?.lastWritten.forEach((v, k) => lastWritten.set(k, v));
  back?.lastValid.forEach((v, k) => lastValid.set(k, v));
  if (!root) return;
  await reload(root);
  api.auxinWatch(root).catch(() => undefined);
  if (!watchUnlisten) {
    watchUnlisten = await api.onFilesChanged((changedRoot) => {
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        if (changedRoot === get().root) void reload(changedRoot, true);
      }, 250);
    });
  }
}

async function reload(root: string, external = false) {
  let files;
  try {
    files = await api.auxinList(root);
  } catch (e) {
    toast("error", "Couldn't read .auxin folder", String(e));
    set({ loaded: true });
    return;
  }
  if (get().root !== root) return;
  const flows: Record<string, FlowDoc> = {};
  const broken: Record<string, string> = {};
  const shared: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const f of files) {
    if (f.path.startsWith("flows/")) {
      // Keep the in-memory doc when it has unsaved edits, or the file is just our own last write.
      const cur = get().flows[f.path];
      if (cur && (pending.has(f.path) || lastWritten.get(f.path) === f.text)) {
        flows[f.path] = cur;
        continue;
      }
      lastWritten.set(f.path, f.text);
      try {
        flows[f.path] = parseFlow(f.path, f.text);
        lastValid.set(f.path, flows[f.path]);
      } catch (e) {
        broken[f.path] = (e as Error).message;
      }
    } else if (f.path.startsWith("env/")) {
      const name = f.path.slice(4).replace(/\.secret\.json$|\.json$/, "");
      (f.path.endsWith(".secret.json") ? secret : shared)[name] = f.text;
      // Known to exist on disk: saving an emptied env must rewrite it, not leave it behind.
      if (!pending.has(f.path)) lastWritten.set(f.path, f.text);
    }
  }
  const envs: Record<string, EnvDoc> = {};
  for (const name of new Set([...Object.keys(shared), ...Object.keys(secret)])) {
    const cur = get().envs[name];
    if (cur && (pending.has(`env/${name}.json`) || pending.has(`env/${name}.secret.json`))) {
      envs[name] = cur;
      continue;
    }
    try {
      envs[name] = parseEnv(name, shared[name], secret[name]);
    } catch (e) {
      broken[`env/${name}.json`] = (e as Error).message;
    }
  }
  set({ flows, broken, envs, loaded: true });
  void loadTopology(root);
  if (external && Object.keys(broken).length) toast("error", "A file in .auxin couldn't be read", Object.entries(broken).map(([p, m]) => `${p}: ${m}`).join("\n"));
}

/* ---------- flows ---------- */

export function flowList(s: FlowsState = get()): FlowDoc[] {
  return Object.values(s.flows).sort((a, b) => a.name.localeCompare(b.name));
}

export function write(path: string, text: string) {
  const root = get().root;
  if (!root) return Promise.resolve();
  lastWritten.set(path, text);
  pending.add(path);
  inflightWrites.set(path, (inflightWrites.get(path) ?? 0) + 1);
  return api
    .auxinWrite(root, path, text)
    .catch((e) => toast("error", `Couldn't save ${path}`, String(e)))
    .finally(() => {
      const left = (inflightWrites.get(path) ?? 1) - 1;
      if (left > 0) inflightWrites.set(path, left);
      else inflightWrites.delete(path);
      // Still pending while another write is in flight or a save is scheduled.
      if (!left && !saveTimers.has(path)) pending.delete(path);
    });
}

/** Writes a file into a workspace's `.auxin`, whether it's the open one or not. */
export function writeTo(root: string, path: string, text: string) {
  if (get().root === root) return write(path, text);
  return api.auxinWrite(root, path, text).catch((e) => toast("error", `Couldn't save ${path}`, String(e)));
}

/** Applies an edit now and writes the file shortly after (edits coalesce). */
export function updateFlow(path: string, fn: (f: FlowDoc) => FlowDoc) {
  const cur = get().flows[path];
  if (!cur) return;
  const next = fn(cur);
  set((s) => ({ flows: { ...s.flows, [path]: next } }));
  window.clearTimeout(saveTimers.get(path));
  pending.add(path);
  saveTimers.set(
    path,
    window.setTimeout(() => {
      saveTimers.delete(path);
      saveNow(path);
    }, 300),
  );
}

function saveNow(path: string) {
  const doc = get().flows[path];
  if (!doc) return void pending.delete(path);
  const { text, invalid } = serializeFlow(doc, lastValid.get(path));
  set((s) => {
    const inv = { ...s.invalid };
    allSteps(doc.steps).forEach((st) => delete inv[rk(path, st.id)]);
    invalid.forEach((id) => (inv[rk(path, id)] = "Invalid JSON: not saved until it parses"));
    return { invalid: inv };
  });
  if (!invalid.length) lastValid.set(path, doc);
  if (lastWritten.get(path) !== text) void write(path, text);
  else pending.delete(path);
}

export function updateStep(path: string, stepId: string, patch: Partial<FlowStep>) {
  updateFlow(path, (f) => ({ ...f, steps: mapSteps(f.steps, (s) => (s.id === stepId ? { ...s, ...patch } : s)) }));
}

export async function createFlow(name = "New flow") {
  const root = get().root;
  if (!root) return;
  const taken = new Set(Object.keys(get().flows));
  let slug = slugify(name);
  for (let i = 2; taken.has(`flows/${slug}.flow.json`); i++) slug = `${slugify(name)}-${i}`;
  const path = `flows/${slug}.flow.json`;
  const doc = newFlow(path, name);
  set((s) => ({ flows: { ...s.flows, [path]: doc } }));
  lastValid.set(path, doc);
  await write(path, serializeFlow(doc).text);
  if (!Object.keys(get().envs).length) await saveEnv(parseEnv("local"));
  navigate({ type: "flow", id: path });
}

export async function confirmDeleteFlow(path: string) {
  const f = get().flows[path];
  if (!f) return;
  const ok = await confirm(`Delete the flow “${f.name}”? This removes .auxin/${path}.`, { title: "Delete flow", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" });
  if (!ok) return;
  const root = get().root;
  set((s) => {
    const flows = { ...s.flows };
    delete flows[path];
    return { flows };
  });
  lastWritten.delete(path);
  if (root) await api.auxinDelete(root, path).catch((e) => toast("error", "Couldn't delete the flow file", String(e)));
  const v = useStore.getState().view;
  if (v.type === "flow" && v.id === path) navigate({ type: "overview" });
}

/* ---------- environments ---------- */

export function activeEnvName(): string {
  const envs = Object.keys(get().envs);
  const chosen = activeWorkspace()?.activeEnv;
  return chosen && envs.includes(chosen) ? chosen : envs.includes("local") ? "local" : (envs[0] ?? "local");
}

export function setActiveEnv(name: string) {
  updateActiveWorkspace((w) => ({ ...w, activeEnv: name }));
}

export async function saveEnv(env: EnvDoc) {
  set((s) => ({ envs: { ...s.envs, [env.name]: env } }));
  const { shared, secret } = serializeEnv(env);
  await write(`env/${env.name}.json`, shared);
  // Only create a secret file once there is something secret to keep.
  if (Object.keys(env.secrets).length || lastWritten.has(`env/${env.name}.secret.json`)) await write(`env/${env.name}.secret.json`, secret);
}

export async function createEnv(name: string) {
  const clean = slugify(name);
  if (get().envs[clean]) return clean;
  await saveEnv(parseEnv(clean));
  setActiveEnv(clean);
  return clean;
}

/* ---------- variables ---------- */

/** Workspace service id for a flow's service ref (refs are relative to the root). */
export function serviceIdFor(ref: string): string {
  return `${get().root}/${ref}`;
}

/** `envName` defaults to the active environment; a run can use another. */
export function servicePorts(doc?: FlowDoc, envName = activeEnvName()): { urls: Record<string, string>; portToService: Record<number, string> } {
  const s = useStore.getState();
  const services = selectServices(s);
  const env = get().envs[envName];
  const urls: Record<string, string> = {};
  const portToService: Record<number, string> = {};
  const urlOf = (svc: (typeof services)[number], name: string) => {
    const port = s.runtime[svc.id]?.port ?? svc.portHint ?? undefined;
    const override = env?.baseUrls[name] ?? env?.baseUrls[svc.name];
    return override || (port ? `http://localhost:${port}` : undefined);
  };
  const flowAlias = new Map((doc?.services ?? []).map((fs) => [serviceIdFor(fs.ref), fs.alias]));
  for (const svc of services) {
    const u = urlOf(svc, svc.name);
    if (u) urls[svc.name] = u;
    const alias = flowAlias.get(svc.id);
    const au = alias && urlOf(svc, alias);
    if (alias && au) urls[alias] = au;
  }
  // Port → name: hints first, then live ports, so a running service always wins its port.
  const name = (svc: (typeof services)[number]) => flowAlias.get(svc.id) ?? svc.name;
  for (const svc of services) if (svc.portHint) portToService[svc.portHint] = name(svc);
  for (const svc of services) {
    const live = s.runtime[svc.id]?.port;
    if (live) portToService[live] = name(svc);
  }
  return { urls, portToService };
}

export function varSources(doc?: FlowDoc, extra?: Record<string, string>, envName = activeEnvName()): VarSources {
  const env = get().envs[envName];
  return { extra, secrets: env?.secrets ?? {}, vars: env?.vars ?? {}, serviceUrls: servicePorts(doc, envName).urls };
}

/** Keep flows in step with the active workspace. */
export function initFlowsSync() {
  let lastRoot: string | null | undefined;
  const check = () => {
    const root = activeWorkspace()?.root ?? null;
    if (root !== lastRoot) {
      lastRoot = root;
      void syncWorkspace(root);
    }
  };
  check();
  return useStore.subscribe(check);
}
