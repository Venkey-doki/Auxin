/**
 * Map state for the active workspace: what discovery found, what runs observed,
 * and your edits (`.auxin/topology.json`). Observations live in `.auxin/runs/`
 * (ignored by git): they describe one machine's runs, not the project.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import { activeWorkspace, selectServices, toast, updateActiveWorkspace, useStore } from "../state/store";
import { updateFlow, useFlows, writeTo } from "../flows/store";
import { emptyTopology, keepEdge, mergeTopology, removeEdge, parseTopology, serializeTopology, serviceKey, type Discovery, type Observation, type TopologyFile } from "./model";

const TOPOLOGY = "topology.json";
const OBSERVED = "runs/observed.json";

interface MapState {
  root: string | null;
  file: TopologyFile;
  observed: Observation[];
  discovery: Discovery | null;
  discovering: boolean;
  /** Why `.auxin/topology.json` couldn't be read. While set, edits aren't saved, so the file isn't overwritten. */
  broken: string | null;
}

export const useMap = create<MapState>(() => ({ root: null, file: emptyTopology(), observed: [], discovery: null, discovering: false, broken: null }));
const set = useMap.setState;
const get = useMap.getState;

/** The text we last wrote, so our own write coming back through the watcher isn't treated as a change. */
let lastWritten: string | null = null;
let saveTimer: number | undefined;
let observedTimer: number | undefined;

/** Maps of workspaces switched away from, so switching back doesn't scan again. */
const parked = new Map<string, Pick<MapState, "file" | "observed" | "discovery">>();

/**
 * Writes waiting on a timer belong to the map's workspace: write them now. The
 * flows store calls this before it switches workspace, so nothing lands in the next one.
 */
export function flushMap() {
  if (get().root) flushTo(get().root!);
}

function flushTo(root: string) {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    lastWritten = serializeTopology(get().file);
    void writeTo(root, TOPOLOGY, lastWritten);
  }
  if (observedTimer !== undefined) {
    window.clearTimeout(observedTimer);
    observedTimer = undefined;
    void writeTo(root, OBSERVED, JSON.stringify(get().observed, null, 2) + "\n");
  }
}

/** Reads the map files for `root`; called by the flows store whenever `.auxin` is (re)loaded. */
export async function loadTopology(root: string) {
  const prev = get().root;
  if (prev !== root) {
    if (prev) {
      flushTo(prev);
      parked.set(prev, { file: get().file, observed: get().observed, discovery: get().discovery });
    }
    set({ root, file: emptyTopology(), observed: [], discovery: null, broken: null, discovering: scanning.has(root), ...parked.get(root) });
    parked.delete(root);
    lastWritten = null;
  }
  const read = (p: string) => api.auxinRead(root, p).catch(() => null);
  const [text, obs] = await Promise.all([read(TOPOLOGY), read(OBSERVED)]);
  if (get().root !== root) return;
  if (text == null) set({ broken: null });
  else if (text !== lastWritten && saveTimer === undefined) {
    try {
      set({ file: parseTopology(text), broken: null });
      lastWritten = text;
    } catch (e) {
      // Often a merge conflict. Keep the file as it is on disk until it's fixed.
      if (!get().broken) toast("error", "Couldn't read .auxin/topology.json", `${String(e)}. Map edits aren't saved until the file is fixed.`);
      set({ broken: String(e) });
    }
  }
  if (obs != null && observedTimer === undefined) {
    try {
      set({ observed: JSON.parse(obs) as Observation[] });
    } catch {
      /* a broken observations file is just dropped; runs refill it */
    }
  }
  adoptFlowLinks();
  if (!get().discovery) void discover();
}

/**
 * Flows used to keep their own links. Hand any still in a flow file to the map
 * (kept links stay kept, dismissed ones stay removed), then drop them from the
 * flow so they're written out of the file.
 */
function adoptFlowLinks() {
  // With topology.json unreadable, the links stay in the flow files until it's fixed.
  if (get().broken) return;
  for (const doc of Object.values(useFlows.getState().flows)) {
    const legacy = doc.legacyLinks;
    if (!legacy) continue;
    const ref = (alias: string) => doc.services.find((f) => f.alias === alias)?.ref;
    editTopology((t) => {
      let next = t;
      for (const l of legacy.kept) if (ref(l.from) && ref(l.to)) next = keepEdge(next, ref(l.from)!, ref(l.to)!, "http");
      for (const l of legacy.dismissed) if (ref(l.from) && ref(l.to)) next = removeEdge(next, ref(l.from)!, ref(l.to)!);
      return next;
    });
    updateFlow(doc.path, ({ legacyLinks: _, ...rest }) => rest);
  }
}

/** Code scanning is your consent on this machine, so it lives in the workspace config, not in the repo. */
export function codeScanAllowed(): boolean {
  return activeWorkspace()?.codeScan === true;
}

export function setCodeScan(on: boolean) {
  updateActiveWorkspace((w) => ({ ...w, codeScan: on }));
  void discover();
}

/** Workspaces with a scan in flight. Kept per workspace, so a switch mid-scan still scans the one you switched to. */
const scanning = new Set<string>();

/** Reads the project's compose, .env, k8s and config files (and code, if allowed) for services and links. */
export async function discover() {
  const root = useFlows.getState().root;
  if (!root || scanning.has(root)) return;
  const s = useStore.getState();
  const services = selectServices(s).map((svc) => ({ key: serviceKey(svc, root), path: svc.path, port: s.runtime[svc.id]?.port ?? svc.portHint ?? null }));
  scanning.add(root);
  if (get().root === root) set({ discovering: true });
  try {
    const discovery = await api.discoverTopology(root, services, codeScanAllowed());
    // Switched away meanwhile: the next visit scans again, since that workspace's discovery was left empty.
    if (get().root === root) set({ discovery });
  } catch (e) {
    if (get().root === root) toast("error", "Couldn't scan the project", String(e));
  } finally {
    scanning.delete(root);
    if (get().root === root) set({ discovering: false });
  }
}

/** Applies an edit to `.auxin/topology.json` now, and writes it shortly after (edits coalesce). */
export function editTopology(fn: (t: TopologyFile) => TopologyFile) {
  if (get().broken) {
    toast("error", "Map edits can't be saved", `.auxin/topology.json can't be read (${get().broken}). Fix the file first, so it isn't overwritten.`);
    return;
  }
  set({ file: fn(get().file) });
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    const root = get().root;
    const text = serializeTopology(get().file);
    if (!root || text === lastWritten) return;
    lastWritten = text;
    void writeTo(root, TOPOLOGY, text);
  }, 300);
}

/**
 * Records links a run in `root` showed (a traced request, an open connection).
 * Kept for a week after last seen. Ignored if the map now shows another workspace.
 */
export function recordObserved(root: string, found: Omit<Observation, "lastSeen">[]) {
  if (!found.length || get().root !== root) return;
  const now = new Date().toISOString();
  const next = [...get().observed];
  for (const f of found) {
    const i = next.findIndex((o) => o.from === f.from && o.to === f.to && o.source === f.source);
    if (i >= 0) next[i] = { ...f, lastSeen: now };
    else next.push({ ...f, lastSeen: now });
  }
  set({ observed: next });
  window.clearTimeout(observedTimer);
  observedTimer = window.setTimeout(() => {
    observedTimer = undefined;
    void writeTo(root, OBSERVED, JSON.stringify(get().observed, null, 2) + "\n");
  }, 1000);
}

/** The merged map for the active workspace. */
export function useTopology() {
  const root = useFlows((s) => s.root);
  const services = useStore(selectServices);
  const file = useMap((s) => s.file);
  const observed = useMap((s) => s.observed);
  const discovery = useMap((s) => s.discovery);
  return useMemo(() => (root ? mergeTopology({ root, services, discovery, observed, file }) : { nodes: [], edges: [] }), [root, services, discovery, observed, file]);
}
