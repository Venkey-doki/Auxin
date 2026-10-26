/**
 * The project map: every service and the infrastructure around it (databases,
 * caches, queues, outside APIs), with who talks to whom and how we know.
 *
 * Three inputs are merged, never mixed up:
 * - discovered: what the files say (compose, .env, k8s, config, and code when allowed);
 * - observed: what runs actually showed (traced log lines, open connections);
 * - your edits, saved in `.auxin/topology.json` and shared through git: links you
 *   added or kept, things you removed, nodes you added, and positions.
 * Your edits always win: a removed link stays removed however often it's found again.
 */
import type { Service } from "../lib/types";

export type NodeKind = "service" | "frontend" | "database" | "cache" | "queue" | "external";
export type EdgeKind = "http" | "database" | "cache" | "queue" | "other";
export type SourceKind = "compose" | "env" | "config" | "k8s" | "code" | "traffic" | "connection" | "otel" | "manual";
/** How sure we are a link exists, strongest first. */
export type Confidence = "manual" | "declared" | "observed" | "inferred";
export const CONFIDENCE_ORDER: Confidence[] = ["manual", "declared", "observed", "inferred"];

export interface Evidence {
  source: SourceKind;
  confidence: Confidence;
  /** `path:line  snippet` for files, a sentence for observations. Credentials are never included. */
  detail: string;
  /** Observations only. */
  lastSeen?: string;
}

/** What the backend found (`discover_topology`). Service nodes come from the service list instead. */
export interface Discovery {
  nodes: { key: string; kind: NodeKind; label: string; tech?: string | null; endpoint?: string | null; evidence: Evidence[] }[];
  edges: { from: string; to: string; kind: EdgeKind; evidence: Evidence[] }[];
}

export interface Observation {
  from: string;
  to: string;
  source: "traffic" | "connection" | "otel";
  detail: string;
  lastSeen: string;
}

export interface TopologyFile {
  version: 1;
  /** Nodes you added by hand, such as an outside API nothing mentions. */
  nodes: { key: string; kind: NodeKind; label: string; endpoint?: string }[];
  /** Links you added, or kept from what was found. */
  edges: { from: string; to: string; kind: EdgeKind }[];
  /** Keys you removed: `a→b` for links, a node key for nodes. Never shown again. */
  removed: string[];
  positions: Record<string, { x: number; y: number }>;
}

export interface MapNode {
  key: string;
  kind: NodeKind;
  label: string;
  tech?: string;
  endpoint?: string;
  /** For service nodes: the workspace service it is. */
  service?: Service;
  manual: boolean;
  evidence: Evidence[];
}

export interface MapEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** The strongest evidence's confidence. */
  confidence: Confidence;
  evidence: Evidence[];
}

export const edgeKey = (e: { from: string; to: string }) => `${e.from}→${e.to}`;

export const emptyTopology = (): TopologyFile => ({ version: 1, nodes: [], edges: [], removed: [], positions: {} });

/** Observations older than this fade from the map; files never expire. */
export const OBSERVED_TTL_MS = 7 * 24 * 3600 * 1000;

const FRONTEND = /^(next|nuxt|vite|react|vue|svelte|sveltekit|angular|remix|astro|gatsby|expo)/i;

/** A service's key on the map: its folder relative to the workspace root, as flows refer to it. */
export function serviceKey(svc: Service, root: string): string {
  return svc.path.startsWith(root + "/") ? svc.path.slice(root.length + 1) : svc.path;
}

export function parseTopology(text: string): TopologyFile {
  const raw = JSON.parse(text) as Partial<TopologyFile>;
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    version: 1,
    nodes: list<TopologyFile["nodes"][number]>(raw.nodes).filter((n) => n && typeof n.key === "string"),
    edges: list<TopologyFile["edges"][number]>(raw.edges).filter((e) => e && typeof e.from === "string" && typeof e.to === "string"),
    removed: list<string>(raw.removed).filter((k) => typeof k === "string"),
    positions: raw.positions && typeof raw.positions === "object" ? raw.positions : {},
  };
}

export function serializeTopology(t: TopologyFile): string {
  return JSON.stringify({ version: 1, nodes: t.nodes, edges: t.edges, removed: [...new Set(t.removed)].sort(), positions: t.positions }, null, 2) + "\n";
}

export function mergeTopology(input: { root: string; services: Service[]; discovery: Discovery | null; observed: Observation[]; file: TopologyFile; now?: number }): { nodes: MapNode[]; edges: MapEdge[] } {
  const { root, services, discovery, observed, file } = input;
  const now = input.now ?? Date.now();
  const removed = new Set(file.removed);
  const nodes = new Map<string, MapNode>();

  for (const svc of services) {
    const key = serviceKey(svc, root);
    nodes.set(key, { key, kind: svc.framework && FRONTEND.test(svc.framework) ? "frontend" : "service", label: svc.name, service: svc, manual: false, evidence: [] });
  }
  for (const n of discovery?.nodes ?? []) {
    if (!nodes.has(n.key)) nodes.set(n.key, { key: n.key, kind: n.kind, label: n.label, tech: n.tech ?? undefined, endpoint: n.endpoint ?? undefined, manual: false, evidence: n.evidence });
  }
  for (const n of file.nodes) if (!nodes.has(n.key)) nodes.set(n.key, { ...n, manual: true, evidence: [{ source: "manual", confidence: "manual", detail: "Added by you" }] });
  for (const k of removed) if (!file.nodes.some((n) => n.key === k)) nodes.delete(k);

  const edges = new Map<string, MapEdge>();
  const add = (from: string, to: string, kind: EdgeKind, evidence: Evidence[]) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    const k = edgeKey({ from, to });
    const cur = edges.get(k);
    if (cur) {
      cur.evidence.push(...evidence);
      if (cur.kind === "other" || cur.kind === "http") cur.kind = kind === "other" ? cur.kind : kind;
    } else edges.set(k, { from, to, kind, confidence: "inferred", evidence: [...evidence] });
  };
  for (const e of discovery?.edges ?? []) add(e.from, e.to, e.kind, e.evidence);
  for (const o of observed) {
    if (now - Date.parse(o.lastSeen) > OBSERVED_TTL_MS) continue;
    add(o.from, o.to, kindTo(nodes.get(o.to)?.kind), [{ source: o.source, confidence: "observed", detail: o.detail, lastSeen: o.lastSeen }]);
  }
  for (const e of file.edges) add(e.from, e.to, e.kind, [{ source: "manual", confidence: "manual", detail: "Added or kept by you" }]);

  for (const e of edges.values()) {
    e.confidence = CONFIDENCE_ORDER.find((c) => e.evidence.some((x) => x.confidence === c)) ?? "inferred";
  }
  // A link you removed stays gone, unless you added it back yourself afterwards.
  const kept = [...edges.values()].filter((e) => !removed.has(edgeKey(e)) || e.confidence === "manual");
  return {
    nodes: [...nodes.values()].sort((a, b) => a.key.localeCompare(b.key)),
    edges: kept.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  };
}

/** The kind of link to a node of this kind. */
export function kindTo(kind: NodeKind | undefined): EdgeKind {
  return kind === "database" ? "database" : kind === "cache" ? "cache" : kind === "queue" ? "queue" : "http";
}

/* ---------- edits (pure; the store saves the result) ---------- */

/** Adds a link, or keeps a found one: it then survives even if the evidence goes away. */
export function keepEdge(t: TopologyFile, from: string, to: string, kind: EdgeKind): TopologyFile {
  const k = edgeKey({ from, to });
  return {
    ...t,
    edges: t.edges.some((e) => edgeKey(e) === k) ? t.edges : [...t.edges, { from, to, kind }],
    removed: t.removed.filter((r) => r !== k),
  };
}

export function removeEdge(t: TopologyFile, from: string, to: string): TopologyFile {
  const k = edgeKey({ from, to });
  return { ...t, edges: t.edges.filter((e) => edgeKey(e) !== k), removed: t.removed.includes(k) ? t.removed : [...t.removed, k] };
}

export function addNode(t: TopologyFile, node: TopologyFile["nodes"][number]): TopologyFile {
  return { ...t, nodes: [...t.nodes.filter((n) => n.key !== node.key), node], removed: t.removed.filter((r) => r !== node.key) };
}

/** Removes a node and every link you added to or from it. */
export function removeNode(t: TopologyFile, key: string): TopologyFile {
  return {
    ...t,
    nodes: t.nodes.filter((n) => n.key !== key),
    edges: t.edges.filter((e) => e.from !== key && e.to !== key),
    removed: t.removed.includes(key) ? t.removed : [...t.removed, key],
  };
}
