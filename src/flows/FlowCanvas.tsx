/**
 * The flow's service map, n8n-style: paper service nodes with connection
 * handles, curved directions labelled by where they were found, a dotted grid
 * to pan and zoom, and run badges replayed hop by hop (docs/flows-spec.md §4, §7).
 */
import { AlertTriangle, ArrowRight, Check, Code2, Globe, LayoutGrid, Maximize, Minus, Plus, Radar, Server, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Popover } from "../components/Popover";
import { Button, CheckBox, cx, IconButton, inputClass, MenuItem, MenuLabel } from "../components/ui";
import type { Service } from "../lib/types";
import { SERVICE_COLORS } from "../lib/util";
import type { Direction, DirectionSource, FlowDoc, FlowService } from "./model";

export const NODE_W = 200;
export const NODE_H = 60;

export type NodeRun = { state: "live" | "ok" | "bad"; ms?: number; approx?: boolean };
export type EdgeRun = "live" | "ok" | "bad";

const SOURCE_SHORT: Record<DirectionSource, string> = { env: "env", config: "config", code: "code", traffic: "seen", connection: "conn", manual: "manual" };
export const SOURCE_LABEL: Record<DirectionSource, string> = {
  env: "Env var",
  config: "Config file",
  code: "Code",
  traffic: "Seen in a trace",
  connection: "Seen as a connection",
  manual: "Added by you",
};

const kindIcon = (kind: string) => (kind === "python" || kind === "go" || kind === "rust" || kind === "java" ? Code2 : kind === "node" ? Server : Globe);

/** Layered left→right layout by direction rank. */
export function autoLayout(aliases: string[], directions: Direction[]): Record<string, { x: number; y: number }> {
  const live = directions.filter((e) => e.confirmed && aliases.includes(e.from) && aliases.includes(e.to));
  const rank = new Map(aliases.map((a) => [a, 0]));
  for (let pass = 0; pass < aliases.length; pass++) for (const e of live) if (rank.get(e.to)! < rank.get(e.from)! + 1 && rank.get(e.from)! < aliases.length) rank.set(e.to, rank.get(e.from)! + 1);
  const cols = new Map<number, string[]>();
  aliases.forEach((a) => cols.set(rank.get(a)!, [...(cols.get(rank.get(a)!) ?? []), a]));
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [r, col] of cols) col.forEach((a, j) => (pos[a] = { x: r * (NODE_W + 96), y: (j - (col.length - 1) / 2) * (NODE_H + 48) }));
  return pos;
}

export interface CanvasNode extends FlowService {
  service?: Service;
  running: boolean;
  port?: number;
}

export function FlowCanvas({
  doc,
  nodes,
  nodeRuns,
  edgeRuns,
  focus,
  focusLabel,
  workspaceServices,
  onMove,
  onArrange,
  onToggleService,
  onAddDirection,
  onKeep,
  onRemove,
  onDetect,
  detecting,
}: {
  doc: FlowDoc;
  nodes: CanvasNode[];
  nodeRuns: Record<string, NodeRun>;
  edgeRuns: Record<string, EdgeRun>;
  /** Aliases on the open request's path; everything else dims. */
  focus: string[] | null;
  focusLabel?: string;
  workspaceServices: Service[];
  onMove: (alias: string, x: number, y: number) => void;
  onArrange: () => void;
  onToggleService: (svc: Service) => void;
  onAddDirection: (from: string, to: string) => void;
  onKeep: (d: Direction) => void;
  onRemove: (d: Direction) => void;
  onDetect: () => void;
  detecting: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 40, y: 0, k: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ alias: string; x: number; y: number } | null>(null);
  const gesture = useRef<{ kind: "pan" | "node"; alias?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  const pos = useMemo(() => {
    const fallback = autoLayout(
      nodes.map((n) => n.alias),
      doc.directions,
    );
    const p: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) p[n.alias] = n.x != null && n.y != null ? { x: n.x, y: n.y } : fallback[n.alias];
    if (drag) p[drag.alias] = { x: drag.x, y: drag.y };
    return p;
  }, [nodes, doc.directions, drag]);

  const fit = useCallback(() => {
    const el = box.current;
    const pts = Object.values(pos);
    if (!el || !pts.length) return;
    const minX = Math.min(...pts.map((p) => p.x)) - 40;
    const maxX = Math.max(...pts.map((p) => p.x + NODE_W)) + 40;
    const minY = Math.min(...pts.map((p) => p.y)) - 56;
    const maxY = Math.max(...pts.map((p) => p.y + NODE_H)) + 70;
    const k = Math.min(1.1, Math.max(0.35, Math.min(el.clientWidth / (maxX - minX), el.clientHeight / (maxY - minY))));
    setView({ k, x: (el.clientWidth - (maxX - minX) * k) / 2 - minX * k, y: (el.clientHeight - (maxY - minY) * k) / 2 - minY * k });
  }, [pos]);

  // Fit on open and when services are added or removed, never on routine
  // re-renders (log lines, drags), so the user's pan and zoom stick.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // Unplaced nodes follow the automatic layout, which changes as directions arrive.
  const autoKey = nodes.some((n) => n.x == null || n.y == null) ? doc.directions.filter((d) => d.confirmed).length : -1;
  useLayoutEffect(() => fitRef.current(), [nodes.length, autoKey]);
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

  const onDown = (e: RPointerEvent, alias?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const o = alias ? pos[alias] : view;
    gesture.current = { kind: alias ? "node" : "pan", alias, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, moved: false };
  };
  const onPointerMove = (e: RPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) g.moved = true;
    if (g.kind === "pan") setView((v) => ({ ...v, x: g.ox + dx, y: g.oy + dy }));
    else setDrag({ alias: g.alias!, x: g.ox + dx / view.k, y: g.oy + dy / view.k });
  };
  const onUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind === "node" && g.moved && drag) onMove(drag.alias, Math.round(drag.x), Math.round(drag.y));
    else if (g?.kind === "pan" && !g.moved) setSelected(null);
    setDrag(null);
  };

  const paths = useMemo(
    () =>
      doc.directions
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
        }),
    [doc.directions, pos],
  );
  const keyOf = (d: Direction) => `${d.from}→${d.to}`;
  const sel = doc.directions.find((d) => keyOf(d) === selected);
  const dimmed = (alias: string) => !!focus && !focus.includes(alias);

  return (
    <div className="relative h-full">
      <div
        ref={box}
        className="relative h-full touch-none overflow-hidden bg-rail select-none"
        style={{ backgroundImage: "radial-gradient(circle, #2c3136 1px, transparent 1.2px)", backgroundSize: `${20 * view.k}px ${20 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={(e) => onDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onUp}
        aria-label="Service map"
      >
        <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="pointer-events-none absolute overflow-visible" width="1" height="1" aria-hidden>
            <defs>
              {(["idle", "live", "ok", "bad"] as const).map((k) => (
                <marker key={k} id={`fc-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
                  <path d="M0 1 9 5 0 9z" fill={k === "ok" ? "#3fb950" : k === "bad" ? "#ef5350" : k === "live" ? "#f0a43a" : "#6b7277"} />
                </marker>
              ))}
            </defs>
            {paths.map(({ e, d }) => {
              const st = (edgeRuns[keyOf(e)] as EdgeRun | undefined) ?? "idle";
              const color = st === "ok" ? "#3fb950" : st === "bad" ? "#ef5350" : st === "live" ? "#f0a43a" : "#6b7277";
              const faded = focus && !(focus.includes(e.from) && focus.includes(e.to));
              return (
                <path
                  key={keyOf(e)}
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={selected === keyOf(e) ? 3 : st === "idle" ? 1.6 : 2.4}
                  strokeDasharray={!e.confirmed ? "4 5" : st === "live" ? "7 5" : undefined}
                  markerEnd={`url(#fc-${st})`}
                  opacity={faded ? 0.25 : e.confirmed ? 1 : 0.75}
                  className={st === "live" ? "[animation:dash_0.5s_linear_infinite]" : undefined}
                />
              );
            })}
          </svg>

          {paths.map(({ e, mid }) => (
            <button
              key={keyOf(e)}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={() => setSelected(selected === keyOf(e) ? null : keyOf(e))}
              className={cx(
                "absolute flex h-5 -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border px-2 font-mono text-2xs whitespace-nowrap transition-colors",
                selected === keyOf(e) ? "border-paper bg-paper text-ink" : "border-line-strong bg-surface text-fg-2 hover:border-fg-3 hover:text-fg",
                !e.confirmed && "border-dashed",
                focus && !(focus.includes(e.from) && focus.includes(e.to)) && "opacity-30",
              )}
              style={{ left: mid.x, top: mid.y }}
              title={`${SOURCE_LABEL[e.source]}: ${e.evidence}`}
              aria-label={`${e.from} to ${e.to}, ${SOURCE_LABEL[e.source]}`}
            >
              {edgeRuns[keyOf(e)] === "bad" && <span className="size-1.5 rounded-full bg-bad" />}
              {SOURCE_SHORT[e.source]}
              {!e.confirmed && " ?"}
            </button>
          ))}

          {nodes.map((n) => {
            const p = pos[n.alias];
            if (!p) return null;
            const run = nodeRuns[n.alias];
            const Icon = kindIcon(n.service?.kind ?? "");
            const color = SERVICE_COLORS[n.service?.color ?? 9];
            return (
              <div
                key={n.alias}
                onPointerDown={(e) => onDown(e, n.alias)}
                className={cx(
                  "on-paper absolute flex cursor-grab items-center gap-2.5 rounded-lg bg-paper pr-3 pl-2 text-ink shadow-[0_6px_18px_rgb(0_0_0/0.35)] transition-[opacity,box-shadow] active:cursor-grabbing",
                  run?.state === "live" && "shadow-[0_0_0_2px_var(--color-warm),0_6px_18px_rgb(0_0_0/0.35)]",
                  run?.state === "bad" && "shadow-[0_0_0_2px_var(--color-bad),0_6px_18px_rgb(0_0_0/0.35)]",
                  run?.state === "ok" && "shadow-[0_0_0_2px_var(--color-ok),0_6px_18px_rgb(0_0_0/0.35)]",
                  dimmed(n.alias) && "opacity-35",
                )}
                style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                title={n.service ? `${n.ref} · ${n.running ? "running" : "stopped"}` : `${n.ref} isn't in this workspace`}
              >
                <span aria-hidden className="absolute top-1/2 -left-[5px] size-2.5 -translate-y-1/2 rounded-full border-2 border-paper bg-idle" />
                <span aria-hidden className="absolute top-1/2 -right-[5px] size-2.5 -translate-y-1/2 rounded-full border-2 border-paper bg-idle" />
                <span className="grid size-9 flex-none place-items-center rounded-md" style={{ background: `color-mix(in oklab, ${color} 28%, #efece4)`, color: `color-mix(in oklab, ${color} 55%, #1c1d1f)` }}>
                  <Icon className="size-[18px]" strokeWidth={2} />
                </span>
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate text-[13px] font-bold tracking-tight">{n.alias}</span>
                  <span className="truncate font-mono text-xs text-ink-2">
                    {n.port ? `:${n.port}` : "port unknown"}
                    {n.service?.framework ? ` · ${n.service.framework}` : ""}
                  </span>
                </span>
                {!n.service ? (
                  <span className="absolute -bottom-2.5 left-3 rounded bg-bad-ink px-1.5 text-2xs text-white">missing</span>
                ) : (
                  !n.running && <span className="absolute -bottom-2.5 left-3 rounded bg-surface-3 px-1.5 text-2xs text-fg-2">stopped</span>
                )}
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

        {!nodes.length && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="max-w-[420px] text-center">
              <p className="font-semibold text-fg">Add the services these requests go through</p>
              <p className="mt-1 text-sm text-fg-3">Auxin finds which one calls which from their config and code, and lights the path when you send a request.</p>
            </div>
          </div>
        )}

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

      <CanvasToolbar
        doc={doc}
        workspaceServices={workspaceServices}
        onToggleService={onToggleService}
        onAddDirection={onAddDirection}
        onArrange={onArrange}
        onDetect={onDetect}
        detecting={detecting}
      />

      {sel && (
        <div className="absolute bottom-3 left-1/2 w-[460px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-lg border border-line-strong bg-pop p-3 shadow-[0_12px_32px_rgb(0_0_0/0.5)] animate-pop" onPointerDown={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{sel.from}</span>
            <ArrowRight className="size-3.5 text-fg-3" />
            <span className="font-semibold">{sel.to}</span>
            <span className={cx("rounded px-1.5 text-xs", sel.confirmed ? "bg-surface-3 text-fg-2" : "border border-dashed border-line-strong text-fg-2")}>
              {SOURCE_LABEL[sel.source]}
              {!sel.confirmed && " · not confirmed"}
            </span>
            <span className="flex-1" />
            <IconButton size="sm" label="Close" onClick={() => setSelected(null)}>
              <X />
            </IconButton>
          </div>
          {sel.evidence && (
            <pre className="mt-2 max-h-24 overflow-auto rounded bg-rail px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-fg-3 select-text">{sel.evidence}</pre>
          )}
          <div className="mt-2.5 flex gap-2">
            {!sel.confirmed && (
              <Button size="sm" variant="primary" onClick={() => onKeep(sel)}>
                <Check /> Keep direction
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                onRemove(sel);
                setSelected(null);
              }}
            >
              <Trash2 /> Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CanvasToolbar({
  doc,
  workspaceServices,
  onToggleService,
  onAddDirection,
  onArrange,
  onDetect,
  detecting,
}: {
  doc: FlowDoc;
  workspaceServices: Service[];
  onToggleService: (svc: Service) => void;
  onAddDirection: (from: string, to: string) => void;
  onArrange: () => void;
  onDetect: () => void;
  detecting: boolean;
}) {
  const [menu, setMenu] = useState<"services" | "link" | null>(null);
  const svcRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLButtonElement>(null);
  const aliases = doc.services.map((s) => s.alias);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const f = from || aliases[0] || "";
  const t = to || aliases.find((a) => a !== f) || "";
  const inFlow = (svc: Service) => doc.services.some((x) => svc.path.endsWith(`/${x.ref}`) || svc.path === x.ref);

  return (
    <div className="absolute top-3 right-3 flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
      <Button ref={svcRef} size="sm" onClick={() => setMenu(menu === "services" ? null : "services")} aria-expanded={menu === "services"}>
        <Plus /> Services
      </Button>
      <Button ref={linkRef} size="sm" disabled={aliases.length < 2} onClick={() => setMenu(menu === "link" ? null : "link")} aria-expanded={menu === "link"}>
        <ArrowRight /> Direction
      </Button>
      <IconButton label="Detect directions again" onClick={onDetect} disabled={detecting || aliases.length < 2}>
        <Radar className={detecting ? "animate-pulse" : undefined} />
      </IconButton>
      <IconButton label="Auto-arrange" onClick={onArrange} disabled={!aliases.length}>
        <LayoutGrid />
      </IconButton>
      <Popover anchor={svcRef} open={menu === "services"} onClose={() => setMenu(null)} align="end" width={300}>
        <MenuLabel>Services in this flow</MenuLabel>
        <div className="max-h-80 overflow-y-auto">
          {workspaceServices.map((s) => (
            <MenuItem key={s.id} onClick={() => onToggleService(s)}>
              <CheckBox on={inFlow(s)} />
              <span className="h-3 w-[3px] flex-none rounded-full" style={{ background: SERVICE_COLORS[s.color] }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
            </MenuItem>
          ))}
        </div>
        <p className="px-2 pt-1.5 pb-1 text-xs text-fg-3">Every service a request can touch. Their logs are searched when tracing.</p>
      </Popover>
      <Popover anchor={linkRef} open={menu === "link"} onClose={() => setMenu(null)} align="end" width={300}>
        <MenuLabel>Add a direction</MenuLabel>
        <div className="grid gap-2 p-2">
          <select className={cx(inputClass, "h-8 appearance-none text-sm")} value={f} onChange={(e) => setFrom(e.target.value)} aria-label="From">
            {aliases.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <div className="flex justify-center text-fg-3">
            <ArrowRight className="size-4 rotate-90" />
          </div>
          <select className={cx(inputClass, "h-8 appearance-none text-sm")} value={t} onChange={(e) => setTo(e.target.value)} aria-label="To">
            {aliases.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <Button
            variant="primary"
            disabled={!f || !t || f === t || doc.directions.some((d) => d.from === f && d.to === t)}
            onClick={() => {
              onAddDirection(f, t);
              setMenu(null);
            }}
          >
            <Plus /> Add direction
          </Button>
        </div>
      </Popover>
    </div>
  );
}
