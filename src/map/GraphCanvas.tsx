/**
 * A pannable, zoomable graph of services and infrastructure, n8n-style: nodes
 * with connection handles, curved links labelled by where they were found, a
 * dotted grid, and run badges replayed hop by hop. Used by the project map and
 * by each flow's own map. Services are paper tickets (the things you run);
 * databases, caches, queues and outside APIs are steel (the things they use).
 */
import { Graph, layout } from "@dagrejs/dagre";
import { AlertTriangle, Check, Code2, Database, Globe, Inbox, Maximize, Minus, Monitor, Plus, Server, Zap, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { cx, IconButton } from "../components/ui";
import { SERVICE_COLORS } from "../lib/util";
import type { NodeKind } from "./model";

export const NODE_W = 200;
export const NODE_H = 60;

export type NodeRun = { state: "live" | "ok" | "bad"; ms?: number; approx?: boolean };
export type EdgeRun = "live" | "ok" | "bad";

export interface GraphNode {
  id: string;
  label: string;
  /** Second line, in mono: a port, an endpoint, a technology. */
  sub?: string;
  kind: NodeKind;
  /** Language of a service (`node`, `python`…), for its icon. */
  lang?: string;
  /** Identity colour index, for services. */
  color?: number;
  /** A small tag under the node: "stopped", "missing"… */
  tag?: { text: string; bad?: boolean };
  title?: string;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Short text on the link, e.g. `compose`, `env`, `seen`. */
  label: string;
  /** Only inferred (a guess from files): drawn dashed. */
  tentative: boolean;
  title: string;
}

export const graphEdgeId = (e: { from: string; to: string }) => `${e.from}→${e.to}`;

const ICON: Record<NodeKind, LucideIcon> = { service: Server, frontend: Monitor, database: Database, cache: Zap, queue: Inbox, external: Globe };
const iconOf = (n: GraphNode): LucideIcon => (n.kind === "service" && ["python", "go", "rust", "java"].includes(n.lang ?? "") ? Code2 : ICON[n.kind]);
const isService = (n: GraphNode) => n.kind === "service" || n.kind === "frontend";

/** Left-to-right layered layout (dagre), for nodes you haven't placed yourself. */
export function autoLayout(nodes: { id: string }[], edges: { from: string; to: string }[]): Record<string, { x: number; y: number }> {
  const g = new Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 96, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  layout(g);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const p = g.node(n.id);
    pos[n.id] = { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) };
  }
  return pos;
}

export function GraphCanvas({
  nodes,
  edges,
  nodeRuns = {},
  edgeRuns = {},
  focus = null,
  focusLabel,
  onMove,
  edgePanel,
  toolbar,
  empty,
  label,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeRuns?: Record<string, NodeRun>;
  edgeRuns?: Record<string, EdgeRun>;
  /** Node ids on the path being shown; everything else dims. */
  focus?: string[] | null;
  focusLabel?: string;
  onMove: (id: string, x: number, y: number) => void;
  /** Details and actions for a selected link. */
  edgePanel: (edge: GraphEdge, close: () => void) => ReactNode;
  toolbar?: ReactNode;
  empty?: ReactNode;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 40, y: 0, k: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const gesture = useRef<{ kind: "pan" | "node"; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  // Only nodes without a saved position follow the automatic layout.
  const unplaced = nodes.filter((n) => n.x == null || n.y == null);
  const layoutKey = unplaced.length ? `${nodes.map((n) => n.id).join("|")}#${edges.map(graphEdgeId).join("|")}` : "";
  const fallback = useMemo(() => (layoutKey ? autoLayout(nodes, edges) : {}), [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pos = useMemo(() => {
    const p: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) p[n.id] = n.x != null && n.y != null ? { x: n.x, y: n.y } : (fallback[n.id] ?? { x: 0, y: 0 });
    if (drag) p[drag.id] = { x: drag.x, y: drag.y };
    return p;
  }, [nodes, fallback, drag]);

  const fit = useCallback(() => {
    const el = box.current;
    const pts = Object.values(pos);
    if (!el || !pts.length) return;
    const minX = Math.min(...pts.map((p) => p.x)) - 40;
    const maxX = Math.max(...pts.map((p) => p.x + NODE_W)) + 40;
    const minY = Math.min(...pts.map((p) => p.y)) - 56;
    const maxY = Math.max(...pts.map((p) => p.y + NODE_H)) + 70;
    const k = Math.min(1.1, Math.max(0.3, Math.min(el.clientWidth / (maxX - minX), el.clientHeight / (maxY - minY))));
    setView({ k, x: (el.clientWidth - (maxX - minX) * k) / 2 - minX * k, y: (el.clientHeight - (maxY - minY) * k) / 2 - minY * k });
  }, [pos]);

  // Fit on open and when nodes come or go, never on routine re-renders (log
  // lines, drags), so the user's pan and zoom stick.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(() => fitRef.current(), [nodes.length, layoutKey]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let w = el.clientWidth;
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      // Only a real size change (window or map resized) re-fits.
      if (el.clientWidth === w && el.clientHeight === h) return;
      w = el.clientWidth;
      h = el.clientHeight;
      fitRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pinch / ⌘+wheel zooms at the cursor; a plain wheel pans (as in n8n).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const k = Math.min(2, Math.max(0.3, v.k * Math.exp(-e.deltaY * 0.01)));
          const cx = e.clientX - r.left;
          const cy = e.clientY - r.top;
          return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (f: number) => {
    const el = box.current!;
    setView((v) => {
      const k = Math.min(2, Math.max(0.3, v.k * f));
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });
  };

  const onDown = (e: RPointerEvent, id?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const o = id ? pos[id] : view;
    gesture.current = { kind: id ? "node" : "pan", id, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, moved: false };
  };
  const onPointerMove = (e: RPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) g.moved = true;
    if (g.kind === "pan") setView((v) => ({ ...v, x: g.ox + dx, y: g.oy + dy }));
    else setDrag({ id: g.id!, x: g.ox + dx / view.k, y: g.oy + dy / view.k });
  };
  const onUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind === "node" && g.moved && drag) onMove(drag.id, Math.round(drag.x), Math.round(drag.y));
    else if (g?.kind === "pan" && !g.moved) setSelected(null);
    setDrag(null);
  };

  const paths = useMemo(
    () =>
      edges
        .filter((e) => pos[e.from] && pos[e.to])
        .map((e) => {
          const a = pos[e.from];
          const b = pos[e.to];
          const sx = a.x + NODE_W + 6;
          const sy = a.y + NODE_H / 2;
          const tx = b.x - 8;
          const ty = b.y + NODE_H / 2;
          if (tx > sx + 20) {
            const dx = Math.max(48, (tx - sx) / 2);
            return { e, d: `M${sx} ${sy} C${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`, mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 } };
          }
          // Backward link: loop under the nodes, like n8n's return connections.
          const low = Math.max(a.y, b.y) + NODE_H + 40;
          return { e, d: `M${sx} ${sy} C${sx + 70} ${sy}, ${sx + 70} ${low}, ${sx} ${low} L${tx} ${low} C${tx - 70} ${low}, ${tx - 70} ${ty}, ${tx} ${ty}`, mid: { x: (sx + tx) / 2, y: low } };
        })
        // Links that cross at their middle would stack their labels; nudge later ones down until clear.
        .map((p, i, all) => {
          const mid = { ...p.mid };
          while (all.slice(0, i).some((q) => Math.abs(q.mid.x - mid.x) < 56 && Math.abs(q.mid.y - mid.y) < 20)) mid.y += 22;
          p.mid = mid;
          return p;
        }),
    [edges, pos],
  );
  const sel = edges.find((e) => graphEdgeId(e) === selected);
  const dimmed = (id: string) => !!focus && !focus.includes(id);
  const offPath = (e: GraphEdge) => !!focus && !(focus.includes(e.from) && focus.includes(e.to));

  return (
    <div className="relative h-full">
      <div
        ref={box}
        className="relative h-full touch-none overflow-hidden bg-rail select-none"
        style={{ backgroundImage: "radial-gradient(circle, #2c3136 1px, transparent 1.2px)", backgroundSize: `${20 * view.k}px ${20 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={(e) => onDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onUp}
        aria-label={label}
      >
        <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="pointer-events-none absolute overflow-visible" width="1" height="1" aria-hidden>
            <defs>
              {(["idle", "live", "ok", "bad"] as const).map((k) => (
                <marker key={k} id={`gc-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
                  <path d="M0 1 9 5 0 9z" fill={k === "ok" ? "#3fb950" : k === "bad" ? "#ef5350" : k === "live" ? "#f0a43a" : "#6b7277"} />
                </marker>
              ))}
            </defs>
            {paths.map(({ e, d }) => {
              const id = graphEdgeId(e);
              const st = (edgeRuns[id] as EdgeRun | undefined) ?? "idle";
              const color = st === "ok" ? "#3fb950" : st === "bad" ? "#ef5350" : st === "live" ? "#f0a43a" : "#6b7277";
              return (
                <path
                  key={id}
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={selected === id ? 3 : st === "idle" ? 1.6 : 2.4}
                  strokeDasharray={e.tentative ? "4 5" : st === "live" ? "7 5" : undefined}
                  markerEnd={`url(#gc-${st})`}
                  opacity={offPath(e) ? 0.25 : e.tentative ? 0.75 : 1}
                  className={st === "live" ? "[animation:dash_0.5s_linear_infinite]" : undefined}
                />
              );
            })}
          </svg>

          {paths.map(({ e, mid }) => {
            const id = graphEdgeId(e);
            return (
              <button
                key={id}
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={() => setSelected(selected === id ? null : id)}
                className={cx(
                  "absolute flex h-5 -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border px-2 font-mono text-2xs whitespace-nowrap transition-colors",
                  selected === id ? "border-paper bg-paper text-ink" : "border-line-strong bg-surface text-fg-2 hover:border-fg-3 hover:text-fg",
                  e.tentative && "border-dashed",
                  offPath(e) && "opacity-30",
                )}
                style={{ left: mid.x, top: mid.y }}
                title={e.title}
                aria-label={`${e.from} to ${e.to}: ${e.title}`}
              >
                {edgeRuns[id] === "bad" && <span className="size-1.5 rounded-full bg-bad" />}
                {e.label}
                {e.tentative && " ?"}
              </button>
            );
          })}

          {nodes.map((n) => {
            const p = pos[n.id];
            const run = nodeRuns[n.id];
            const Icon = iconOf(n);
            const paper = isService(n);
            const color = SERVICE_COLORS[n.color ?? 9];
            return (
              <div
                key={n.id}
                onPointerDown={(e) => onDown(e, n.id)}
                className={cx(
                  "absolute flex cursor-grab items-center gap-2.5 rounded-lg pr-3 pl-2 transition-[opacity,box-shadow] active:cursor-grabbing",
                  paper ? "on-paper bg-paper text-ink shadow-[0_6px_18px_rgb(0_0_0/0.35)]" : "border border-line-strong bg-surface-2 text-fg",
                  run?.state === "live" && "shadow-[0_0_0_2px_var(--color-warm),0_6px_18px_rgb(0_0_0/0.35)]",
                  run?.state === "bad" && "shadow-[0_0_0_2px_var(--color-bad),0_6px_18px_rgb(0_0_0/0.35)]",
                  run?.state === "ok" && "shadow-[0_0_0_2px_var(--color-ok),0_6px_18px_rgb(0_0_0/0.35)]",
                  dimmed(n.id) && "opacity-35",
                )}
                style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                title={n.title}
              >
                <span aria-hidden className={cx("absolute top-1/2 -left-[5px] size-2.5 -translate-y-1/2 rounded-full border-2 bg-idle", paper ? "border-paper" : "border-surface-2")} />
                <span aria-hidden className={cx("absolute top-1/2 -right-[5px] size-2.5 -translate-y-1/2 rounded-full border-2 bg-idle", paper ? "border-paper" : "border-surface-2")} />
                <span
                  className={cx("grid size-9 flex-none place-items-center rounded-md", !paper && "bg-surface-3 text-fg-2")}
                  style={paper ? { background: `color-mix(in oklab, ${color} 28%, #efece4)`, color: `color-mix(in oklab, ${color} 55%, #1c1d1f)` } : undefined}
                >
                  <Icon className="size-[18px]" strokeWidth={2} />
                </span>
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate text-[13px] font-bold tracking-tight">{n.label}</span>
                  {n.sub && <span className={cx("truncate font-mono text-xs", paper ? "text-ink-2" : "text-fg-3")}>{n.sub}</span>}
                </span>
                {n.tag && <span className={cx("absolute -bottom-2.5 left-3 rounded px-1.5 text-2xs", n.tag.bad ? "bg-bad-ink text-white" : "bg-surface-3 text-fg-2")}>{n.tag.text}</span>}
                {run && (
                  <span
                    className={cx("absolute -top-2 -right-2 grid size-5 place-items-center rounded-full text-white shadow", run.state === "ok" ? "bg-ok-ink" : run.state === "bad" ? "bg-bad-ink" : "bg-warm-ink")}
                    aria-label={run.state === "ok" ? "Passed" : run.state === "bad" ? "Failed" : "In progress"}
                  >
                    {run.state === "ok" ? <Check className="size-3" strokeWidth={3} /> : run.state === "bad" ? <AlertTriangle className="size-3" strokeWidth={2.5} /> : <span className="size-2.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
                  </span>
                )}
                {run?.ms != null && (
                  <span className={cx("absolute -top-5 left-2 font-mono text-xs", run.state === "bad" ? "text-bad-soft" : "text-fg-2")} title={run.approx ? "From log timestamps (approximate)" : "Measured response time"}>
                    {run.approx ? "≈" : ""}
                    {run.ms >= 1000 ? `${(run.ms / 1000).toFixed(2)}s` : `${run.ms}ms`}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {!nodes.length && empty && <div className="pointer-events-none absolute inset-0 grid place-items-center">{empty}</div>}

        {focus && focusLabel && <div className="pointer-events-none absolute top-3 left-3 rounded-md bg-surface/90 px-2.5 py-1 text-xs text-fg-2">{focusLabel}</div>}

        <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-md border border-line-strong bg-surface p-0.5" onPointerDown={(e) => e.stopPropagation()}>
          <IconButton size="sm" label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            <Minus />
          </IconButton>
          <span className="w-10 text-center font-mono text-xs text-fg-3">{Math.round(view.k * 100)}%</span>
          <IconButton size="sm" label="Zoom in" onClick={() => zoomBy(1.2)}>
            <Plus />
          </IconButton>
          <IconButton size="sm" label="Fit to view" onClick={fit}>
            <Maximize />
          </IconButton>
        </div>
      </div>

      {toolbar && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
          {toolbar}
        </div>
      )}

      {sel && (
        <div
          className="absolute bottom-3 left-1/2 w-[480px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-lg border border-line-strong bg-pop p-3 shadow-[0_12px_32px_rgb(0_0_0/0.5)] animate-pop"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {edgePanel(sel, () => setSelected(null))}
        </div>
      )}
    </div>
  );
}
