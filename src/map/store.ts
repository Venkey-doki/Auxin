/**
 * Map state for the active workspace: what discovery found, what runs observed,
 * and your edits (`.auxin/topology.json`). Observations live in `.auxin/runs/`
 * (ignored by git): they describe one machine's runs, not the project.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import { activeWorkspace, selectServices, toast, updateActiveWorkspace, useStore } from "../state/store";
import { updateFlow, useFlows, write } from "../flows/store";
import { emptyTopology, keepEdge, mergeTopology, removeEdge, parseTopology, serializeTopology, serviceKey, type Discovery, type Observation, type TopologyFile } from "./model";

const TOPOLOGY = "topology.json";
const OBSERVED = "runs/observed.json";

interface MapState {
  root: string | null;
  file: TopologyFile;
  observed: Observation[];
  discovery: Discovery | null;
  discovering: boolean;
}

export const useMap = create<MapState>(() => ({ root: null, file: emptyTopology(), observed: [], discovery: null, discovering: false }));
const set = useMap.setState;
const get = useMap.getState;

/** The text we last wrote, so our own write coming back through the watcher isn't treated as a change. */
let lastWritten: string | null = null;
let saveTimer: number | undefined;
let observedTimer: number | undefined;

/** Reads the map files for `root`; called by the flows store whenever `.auxin` is (re)loaded. */
export async function loadTopology(root: string) {
  if (get().root !== root) set({ root, file: emptyTopology(), observed: [], discovery: null });
  const read = (p: string) => api.auxinRead(root, p).catch(() => null);
  const [text, obs] = await Promise.all([read(TOPOLOGY), read(OBSERVED)]);
  if (get().root !== root) return;
  if (text != null && text !== lastWritten && saveTimer === undefined) {
    try {
      set({ file: parseTopology(text) });
      lastWritten = text;
    } catch (e) {
      toast("error", "Couldn't read .auxin/topology.json", String(e));
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

/** Reads the project's compose, .env, k8s and config files (and code, if allowed) for services and links. */
export async function discover() {
  const root = useFlows.getState().root;
  if (!root || get().discovering) return;
  const s = useStore.getState();
  const services = selectServices(s).map((svc) => ({ key: serviceKey(svc, root), path: svc.path, port: s.runtime[svc.id]?.port ?? svc.portHint ?? null }));
  set({ discovering: true });
  try {
    const discovery = await api.discoverTopology(root, services, codeScanAllowed());
    if (useFlows.getState().root === root) set({ discovery });
  } catch (e) {
    toast("error", "Couldn't scan the project", String(e));
  } finally {
    set({ discovering: false });
  }
}

/** Applies an edit to `.auxin/topology.json` now, and writes it shortly after (edits coalesce). */
export function editTopology(fn: (t: TopologyFile) => TopologyFile) {
  set({ file: fn(get().file) });
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    const text = serializeTopology(get().file);
    if (text === lastWritten) return;
    lastWritten = text;
    void write(TOPOLOGY, text);
  }, 300);
}

/** Records links a run showed (a traced request, an open connection). Kept for a week after last seen. */
export function recordObserved(found: Omit<Observation, "lastSeen">[]) {
  if (!found.length) return;
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
    void write(OBSERVED, JSON.stringify(get().observed, null, 2) + "\n");
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
