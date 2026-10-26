/**
 * The flow's service map above the requests: services as small tickets, the
 * directions between them, and the hops of the selected request lit in order.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Service } from "../lib/types";
import { selectServices, toast, useStore } from "../state/store";
import { autoLayout, FlowCanvas, type CanvasNode, type EdgeRun, type NodeRun } from "./FlowCanvas";
import { allSteps, type FlowDoc } from "./model";
import { addDirections } from "./runner";
import { rk, serviceIdFor, updateFlow, useFlows } from "./store";
import type { TraceResult } from "./trace";

/* ---------------- service map ---------------- */

export function ServiceMap({ doc, openId, height, setHeight }: { doc: FlowDoc; openId: string | null; height: number; setHeight: (h: number) => void }) {
  const services = useStore(selectServices);
  const runtime = useStore((s) => s.runtime);
  const root = useFlows((s) => s.root);
  const responses = useFlows((s) => s.responses);
  const run = useFlows((s) => s.runs[doc.path]);
  const [detecting, setDetecting] = useState(false);
  const last = useRef<number | null>(null);

  const nodes: CanvasNode[] = useMemo(
    () =>
      doc.services.map((f) => {
        const service = services.find((s) => s.id === serviceIdFor(f.ref));
        return {
          ...f,
          service,
          running: !!service && runtime[service.id]?.status === "running",
          port: service ? (runtime[service.id]?.port ?? service.portHint ?? undefined) : undefined,
        };
      }),
    [doc.services, services, runtime], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Which trace to show: the request being sent during a run, else the open one.
  const focusStep =
    (run?.status === "running" ? allSteps(doc.steps).find((s) => ["sending", "polling"].includes(responses[rk(doc.path, s.id)]?.state ?? "")) : undefined) ??
    allSteps(doc.steps).find((s) => s.id === openId);
  const out = focusStep ? responses[rk(doc.path, focusStep.id)] : undefined;
  const trace = out?.trace;
  const replay = useHopReplay(trace);
  const focus = trace?.hops.length ? trace.hops.map((h) => h.alias) : null;

  const detect = async (forDoc: FlowDoc = doc) => {
    if (!root || forDoc.services.length < 2) return;
    setDetecting(true);
    try {
      const infos = forDoc.services.map((f) => {
        const svc = services.find((s) => s.id === serviceIdFor(f.ref));
        const port = svc ? (runtime[svc.id]?.port ?? svc.portHint ?? null) : null;
        return { alias: f.alias, path: serviceIdFor(f.ref), port };
      });
      const found = await api.detectDirections(root, infos);
      addDirections(
        forDoc.path,
        found.map((e) => ({ from: e.from, to: e.to, source: e.source, evidence: e.evidence.join("\n"), confirmed: true })),
      );
      if (!found.length && infos.some((i) => i.port == null))
        toast("info", "No directions found yet", "Some services' ports aren't known. Start them once so Auxin learns their ports, then detect again.");
    } catch (e) {
      toast("error", "Couldn't detect directions", String(e));
    } finally {
      setDetecting(false);
    }
  };

  // A flow with services but no directions yet: detect once when it's opened.
  const autoDetected = useRef(false);
  useEffect(() => {
    if (autoDetected.current || doc.services.length < 2 || doc.directions.length || !root) return;
    autoDetected.current = true;
    void detect();
  }, [doc.services.length, doc.directions.length, root]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleService = (svc: Service) => {
    const ref = root && svc.path.startsWith(root + "/") ? svc.path.slice(root.length + 1) : svc.path;
    const has = doc.services.find((x) => x.ref === ref);
    if (has) {
      updateFlow(doc.path, (f) => ({
        ...f,
        services: f.services.filter((x) => x.ref !== ref),
        directions: f.directions.filter((d) => d.from !== has.alias && d.to !== has.alias),
      }));
      return;
    }
    const taken = new Set(doc.services.map((x) => x.alias));
    let alias = svc.name;
    for (let i = 2; taken.has(alias); i++) alias = `${svc.name}-${i}`;
    const next: FlowDoc = { ...doc, services: [...doc.services, { ref, alias }] };
    updateFlow(doc.path, (f) => ({ ...f, services: [...f.services, { ref, alias }] }));
    void detect(next);
  };

  if (height === 0)
    return (
      <button
        className="flex h-8 flex-none items-center gap-2 border-b border-line bg-rail px-6 text-left text-xs text-fg-3 hover:text-fg-2"
        onClick={() => setHeight(280)}
      >
        <ChevronRight className="size-3.5" /> Service map
        <span className="font-mono">
          {doc.services.length} services · {doc.directions.length} directions
        </span>
      </button>
    );

  return (
    <div className="relative flex-none border-b border-line" style={{ height }}>
      <FlowCanvas
        doc={doc}
        nodes={nodes}
        nodeRuns={replay.nodes}
        edgeRuns={replay.edges}
        focus={focus}
        focusLabel={
          focusStep && focus
            ? `Path of request ${allSteps(doc.steps).indexOf(focusStep) + 1}${trace?.hops.some((h) => h.approx) ? " · ≈ times from logs" : ""}`
            : undefined
        }
        workspaceServices={services}
        onMove={(alias, x, y) => updateFlow(doc.path, (f) => ({ ...f, services: f.services.map((s) => (s.alias === alias ? { ...s, x, y } : s)) }))}
        onArrange={() => {
          const p = autoLayout(
            doc.services.map((s) => s.alias),
            doc.directions,
          );
          updateFlow(doc.path, (f) => ({ ...f, services: f.services.map((s) => ({ ...s, ...p[s.alias] })) }));
        }}
        onToggleService={toggleService}
        onAddDirection={(from, to) => addDirections(doc.path, [{ from, to, source: "manual", evidence: "Added by hand", confirmed: true }])}
        onKeep={(d) =>
          updateFlow(doc.path, (f) => ({ ...f, directions: f.directions.map((x) => (x.from === d.from && x.to === d.to ? { ...x, confirmed: true } : x)) }))
        }
        onRemove={(d) =>
          updateFlow(doc.path, (f) => ({
            ...f,
            directions: f.directions.filter((x) => !(x.from === d.from && x.to === d.to)),
            dismissed: [...f.dismissed, { from: d.from, to: d.to }],
          }))
        }
        onDetect={() => void detect()}
        detecting={detecting}
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
