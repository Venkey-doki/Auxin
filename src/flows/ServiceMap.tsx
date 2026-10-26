/**
 * The flow's own map above the requests: the services this flow touches, the
 * links between them from the project map, and the hops of the selected
 * request lit in order. Links are edited here or on the Map screen; both
 * change the same `.auxin/topology.json`.
 */
import { ArrowRight, ChevronDown, ChevronRight, LayoutGrid, Plus, Radar } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "../components/Popover";
import { Button, CheckBox, cx, IconButton, inputClass, MenuItem, MenuLabel } from "../components/ui";
import type { Service } from "../lib/types";
import { SERVICE_COLORS } from "../lib/util";
import { EdgePanel, toGraphEdge } from "../map/EdgePanel";
import { autoLayout, GraphCanvas, graphEdgeId, type EdgeRun, type GraphNode, type NodeRun } from "../map/GraphCanvas";
import { edgeKey, keepEdge, kindTo, removeEdge } from "../map/model";
import { discover, editTopology, useMap, useTopology } from "../map/store";
import { selectServices, useStore } from "../state/store";
import { allSteps, type FlowDoc } from "./model";
import { rk, serviceIdFor, updateFlow, useFlows } from "./store";
import type { TraceResult } from "./trace";

/* ---------------- service map ---------------- */

export function ServiceMap({ doc, openId, height, setHeight }: { doc: FlowDoc; openId: string | null; height: number; setHeight: (h: number) => void }) {
  const services = useStore(selectServices);
  const runtime = useStore((s) => s.runtime);
  const root = useFlows((s) => s.root);
  const responses = useFlows((s) => s.responses);
  const run = useFlows((s) => s.runs[doc.path]);
  const discovering = useMap((s) => s.discovering);
  const topology = useTopology();
  const last = useRef<number | null>(null);

  // The flow's nodes are named by alias (that's what {{variables}} and traces use); the map by folder.
  const aliasOf = useMemo(() => new Map(doc.services.map((f) => [f.ref, f.alias])), [doc.services]);
  const refOf = useMemo(() => new Map(doc.services.map((f) => [f.alias, f.ref])), [doc.services]);
  const nodes: GraphNode[] = useMemo(
    () =>
      doc.services.map((f) => {
        const service = services.find((s) => s.id === serviceIdFor(f.ref));
        const port = service ? (runtime[service.id]?.port ?? service.portHint ?? undefined) : undefined;
        const running = !!service && runtime[service.id]?.status === "running";
        return {
          id: f.alias,
          label: f.alias,
          sub: `${port ? `:${port}` : "port unknown"}${service?.framework ? ` · ${service.framework}` : ""}`,
          kind: "service",
          lang: service?.kind,
          color: service?.color,
          tag: !service ? { text: "missing", bad: true } : running ? undefined : { text: "stopped" },
          title: service ? `${f.ref} · ${running ? "running" : "stopped"}` : `${f.ref} isn't in this workspace`,
          x: f.x,
          y: f.y,
        };
      }),
    [doc.services, services, runtime],
  );
  const links = topology.edges.filter((e) => aliasOf.has(e.from) && aliasOf.has(e.to));
  const edges = links.map((e) => toGraphEdge(e, (k) => aliasOf.get(k)!));

  // Which trace to show: the request being sent during a run, else the open one.
  const focusStep =
    (run?.status === "running" ? allSteps(doc.steps).find((s) => ["sending", "polling"].includes(responses[rk(doc.path, s.id)]?.state ?? "")) : undefined) ??
    allSteps(doc.steps).find((s) => s.id === openId);
  const out = focusStep ? responses[rk(doc.path, focusStep.id)] : undefined;
  const trace = out?.trace;
  const replay = useHopReplay(trace);
  const focus = trace?.hops.length ? trace.hops.map((h) => h.alias) : null;

  const toggleService = (svc: Service) => {
    const ref = root && svc.path.startsWith(root + "/") ? svc.path.slice(root.length + 1) : svc.path;
    if (doc.services.some((x) => x.ref === ref)) {
      updateFlow(doc.path, (f) => ({ ...f, services: f.services.filter((x) => x.ref !== ref) }));
      return;
    }
    const taken = new Set(doc.services.map((x) => x.alias));
    let alias = svc.name;
    for (let i = 2; taken.has(alias); i++) alias = `${svc.name}-${i}`;
    updateFlow(doc.path, (f) => ({ ...f, services: [...f.services, { ref, alias }] }));
  };

  if (height === 0)
    return (
      <button
        className="flex h-8 flex-none items-center gap-2 border-b border-line bg-rail px-6 text-left text-xs text-fg-3 hover:text-fg-2"
        onClick={() => setHeight(280)}
      >
        <ChevronRight className="size-3.5" /> Service map
        <span className="font-mono">
          {doc.services.length} services · {links.length} links
        </span>
      </button>
    );

  return (
    <div className="relative flex-none border-b border-line" style={{ height }}>
      <GraphCanvas
        label="Service map"
        nodes={nodes}
        edges={edges}
        nodeRuns={replay.nodes}
        edgeRuns={replay.edges}
        focus={focus}
        focusLabel={
          focusStep && focus
            ? `Path of request ${allSteps(doc.steps).indexOf(focusStep) + 1}${trace?.hops.some((h) => h.approx) ? " · ≈ times from logs" : ""}`
            : undefined
        }
        onMove={(alias, x, y) => updateFlow(doc.path, (f) => ({ ...f, services: f.services.map((s) => (s.alias === alias ? { ...s, x, y } : s)) }))}
        edgePanel={(g, close) => {
          const e = links.find((l) => graphEdgeId({ from: aliasOf.get(l.from)!, to: aliasOf.get(l.to)! }) === graphEdgeId(g))!;
          return (
            <EdgePanel
              edge={e}
              fromLabel={g.from}
              toLabel={g.to}
              onKeep={() => editTopology((t) => keepEdge(t, e.from, e.to, e.kind))}
              onRemove={() => editTopology((t) => removeEdge(t, e.from, e.to))}
              onClose={close}
            />
          );
        }}
        toolbar={
          <FlowMapToolbar
            doc={doc}
            workspaceServices={services}
            onToggleService={toggleService}
            onAddLink={(from, to) => {
              const a = refOf.get(from)!;
              const b = refOf.get(to)!;
              editTopology((t) => keepEdge(t, a, b, kindTo(topology.nodes.find((n) => n.key === b)?.kind)));
            }}
            hasLink={(from, to) => links.some((l) => edgeKey(l) === edgeKey({ from: refOf.get(from)!, to: refOf.get(to)! }))}
            onArrange={() => {
              const p = autoLayout(nodes, edges);
              updateFlow(doc.path, (f) => ({ ...f, services: f.services.map((s) => ({ ...s, ...p[s.alias] })) }));
            }}
            onDetect={() => void discover()}
            detecting={discovering}
          />
        }
        empty={
          <div className="max-w-[420px] text-center">
            <p className="font-semibold text-fg">Add the services these requests go through</p>
            <p className="mt-1 text-sm text-fg-3">Links between them come from the project map, and light up hop by hop when you send a request.</p>
          </div>
        }
      />
      <button
        className="absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-md bg-surface/90 px-2 py-0.5 text-xs text-fg-3 hover:text-fg"
        onClick={() => setHeight(0)}
        title="Collapse the service map"
      >
        <ChevronDown className="inline size-3.5" /> Hide map
      </button>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize service map"
        className="group absolute inset-x-0 -bottom-1.5 z-10 flex h-3 cursor-row-resize items-center justify-center"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          last.current = e.clientY;
        }}
        onPointerMove={(e) => {
          if (last.current == null) return;
          setHeight(Math.min(600, Math.max(140, height + e.clientY - last.current)));
          last.current = e.clientY;
        }}
        onPointerUp={() => (last.current = null)}
      >
        <span className="h-1 w-10 rounded-full bg-line-strong transition-colors group-hover:bg-fg-3" />
      </div>
    </div>
  );
}

function FlowMapToolbar({
  doc,
  workspaceServices,
  onToggleService,
  onAddLink,
  hasLink,
  onArrange,
  onDetect,
  detecting,
}: {
  doc: FlowDoc;
  workspaceServices: Service[];
  onToggleService: (svc: Service) => void;
  onAddLink: (from: string, to: string) => void;
  hasLink: (from: string, to: string) => boolean;
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
    <>
      <Button ref={svcRef} size="sm" onClick={() => setMenu(menu === "services" ? null : "services")} aria-expanded={menu === "services"}>
        <Plus /> Services
      </Button>
      <Button ref={linkRef} size="sm" disabled={aliases.length < 2} onClick={() => setMenu(menu === "link" ? null : "link")} aria-expanded={menu === "link"}>
        <ArrowRight /> Link
      </Button>
      <IconButton label="Scan the project again" onClick={onDetect} disabled={detecting}>
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
        <MenuLabel>Add a link</MenuLabel>
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
            disabled={!f || !t || f === t || hasLink(f, t)}
            onClick={() => {
              onAddLink(f, t);
              setMenu(null);
            }}
          >
            <Plus /> Add link
          </Button>
          <p className="text-xs text-fg-3">Links are saved on the project map, so every flow sees them.</p>
        </div>
      </Popover>
    </>
  );
}

/** Replays a trace's hops one by one (amber, then green or red) whenever a new trace lands. */
function useHopReplay(trace: TraceResult | undefined) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    setShown(0);
    if (!trace) return;
    let i = 0;
    const t = window.setInterval(() => {
      i++;
      setShown(i);
      if (i >= trace.hops.length * 2) window.clearInterval(t);
    }, 160);
    return () => window.clearInterval(t);
  }, [trace]);
  return useMemo(() => {
    const nodes: Record<string, NodeRun> = {};
    const edges: Record<string, EdgeRun> = {};
    if (!trace) return { nodes, edges };
    trace.hops.forEach((h, i) => {
      const step = shown - i * 2;
      if (step < 0) return;
      const done = step >= 1;
      nodes[h.alias] = done ? { state: h.ok ? "ok" : "bad", ms: h.ms, approx: h.approx } : { state: "live" };
      if (i > 0) edges[`${trace.hops[i - 1].alias}→${h.alias}`] = done ? (h.ok ? "ok" : "bad") : "live";
    });
    return { nodes, edges };
  }, [trace, shown]);
}
