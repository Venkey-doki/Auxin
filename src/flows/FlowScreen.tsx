/**
 * A flow: the service map (n8n-style canvas) over the requests, as
 * Linear-style rows that open into an Insomnia-style request | response split
 * with the request's trace. docs/flows-spec.md §7.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  FileJson,
  FolderOpen,
  GripVertical,
  History,
  Play,
  Plus,
  Settings2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditableTitle } from "../components/GroupView";
import { StatusMark, STATUS_TEXT, type Shown } from "../components/status";
import { Button, cx, IconButton, inputClass, Seg, SegButton, TopBar } from "../components/ui";
import { api } from "../lib/api";
import { parseCurl, toCurl } from "../lib/curl";
import type { Service } from "../lib/types";
import { formatClock, MOD, SERVICE_COLORS } from "../lib/util";
import { selectServices, startService, toast, useStore } from "../state/store";
import { EnvPanel } from "./EnvPanel";
import { autoLayout, FlowCanvas, type CanvasNode, type EdgeRun, type NodeRun } from "./FlowCanvas";
import { HistoryPanel } from "./HistoryPanel";
import { blankStep, CHECK_OPS, type BodyKind, type Check, type CheckOp, type FlowDoc, type FlowStep } from "./model";
import { formatBytes, formatMs, Json, KVTable, METHOD_COLOR, MethodBadge, METHODS, Tabs, VarInput } from "./parts";
import { addDirections, cancelRun, cancelStep, isRunning, runFlow, sendStep, type StepOutcome } from "./runner";
import { activeEnvName, confirmDeleteFlow, rk, saveEnv, serviceIdFor, servicePorts, setActiveEnv, updateFlow, updateStep, useFlows, varSources } from "./store";
import type { TraceLine, TraceResult } from "./trace";
import { resolve, resolveHidingSecrets, templatize } from "./vars";

const CANVAS_KEY = "auxin.flowCanvasHeight";
const readCanvasH = () => {
  try {
    const raw = localStorage.getItem(CANVAS_KEY);
    if (raw === "0") return 0;
    const v = Number(raw);
    return v >= 140 ? v : 280;
  } catch {
    return 280;
  }
};

export function FlowScreen({ path }: { path: string }) {
  const loaded = useFlows((s) => s.loaded);
  const doc = useFlows((s) => s.flows[path]);
  const envs = useFlows((s) => s.envs);
  const run = useFlows((s) => s.runs[path]);
  const responses = useFlows((s) => s.responses);
  useStore((s) => s.config); // the chosen environment lives in the workspace config
  const [openId, setOpenId] = useState<string | null>(null);
  const [panel, setPanel] = useState<"env" | "history" | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [canvasH, setCanvasH] = useState(readCanvasH);

  // Open the first request once, when the flow is first shown; after that rows stay as the user leaves them.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !doc?.steps[0]) return;
    autoOpened.current = true;
    setOpenId(doc.steps[0].id);
  }, [doc]);

  // ⌘↵ sends the open request, ⌘⇧↵ runs the flow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter" || !doc) return;
      e.preventDefault();
      // Held keys auto-repeat; a duplicate POST is never what anyone wants.
      if (e.repeat || isRunning(path)) return;
      if (e.shiftKey) void runFlow(path);
      else {
        const st = doc.steps.find((s) => s.id === openId);
        if (st) void sendStep(path, st);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, openId, path]);

  // While a run is going, keep the request being sent open.
  const activeStep = run?.status === "running" ? doc?.steps.find((s) => ["sending", "polling"].includes(responses[rk(path, s.id)]?.state ?? "")) : undefined;
  useEffect(() => {
    if (activeStep) setOpenId(activeStep.id);
  }, [activeStep?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!loaded) return <div className="grid flex-1 place-items-center text-fg-3">Loading flows…</div>;
  if (!doc) return <div className="grid flex-1 place-items-center text-fg-3">This flow no longer exists in .auxin/flows.</div>;

  const running = run?.status === "running";
  const move = (from: string, to: string) =>
    updateFlow(path, (f) => {
      const steps = [...f.steps];
      const a = steps.findIndex((s) => s.id === from);
      const b = steps.findIndex((s) => s.id === to);
      if (a < 0 || b < 0 || a === b) return f;
      const [it] = steps.splice(a, 1);
      steps.splice(b, 0, it);
      return { ...f, steps };
    });
  const setH = (h: number) => {
    setCanvasH(h);
    try {
      localStorage.setItem(CANVAS_KEY, String(h));
    } catch {
      /* per-machine convenience */
    }
  };

  return (
    <>
      <TopBar>
        <EditableTitle value={doc.name} onChange={(name) => updateFlow(path, (f) => ({ ...f, name }))} />
        <RunSummary doc={doc} />
        <span className="flex-1" />
        <select
          className="h-7 flex-none rounded-md border border-line-strong bg-rail pr-7 pl-2.5 text-sm text-fg"
          aria-label="Environment"
          value={activeEnvName()}
          onChange={(e) => setActiveEnv(e.target.value)}
        >
          {(Object.keys(envs).length ? Object.keys(envs) : ["local"]).map((n) => (
            <option key={n} value={n}>
              env: {n}
            </option>
          ))}
        </select>
        <IconButton label="Environment" pressed={panel === "env"} onClick={() => setPanel(panel === "env" ? null : "env")}>
          <Settings2 />
        </IconButton>
        <IconButton label="Run history" pressed={panel === "history"} onClick={() => setPanel(panel === "history" ? null : "history")}>
          <History />
        </IconButton>
        {running ? (
          <Button onClick={() => cancelRun(path)}>
            <Square /> Stop
          </Button>
        ) : (
          <Button variant="primary" disabled={!doc.steps.length} onClick={() => void runFlow(path)} title={`Run every request in order (${MOD}⇧↵)`}>
            <Play /> Run flow
          </Button>
        )}
        <IconButton label="Delete flow" onClick={() => void confirmDeleteFlow(path)}>
          <Trash2 />
        </IconButton>
      </TopBar>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ServiceMap doc={doc} openId={openId} height={canvasH} setHeight={setH} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1240px] px-6 pt-4 pb-12">
              {doc.steps.length > 0 && (
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-semibold tracking-wider text-fg-3 uppercase">Requests</span>
                  <span className="font-mono text-xs text-fg-3">{doc.steps.length}</span>
                  <span className="flex-1" />
                  <span className="text-xs text-fg-3">
                    <kbd className="font-mono">{MOD}↵</kbd> send · <kbd className="font-mono">{MOD}⇧↵</kbd> run all
                  </span>
                </div>
              )}
              {doc.steps.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-line">
                  {doc.steps.map((st, i) => (
                    <StepRow
                      key={st.id}
                      path={path}
                      n={i + 1}
                      step={st}
                      open={openId === st.id}
                      onToggle={() => setOpenId(openId === st.id ? null : st.id)}
                      dragging={dragId === st.id}
                      locked={running}
                      onDragStart={() => setDragId(st.id)}
                      onDragEnter={() => dragId && dragId !== st.id && move(dragId, st.id)}
                      onDragEnd={() => setDragId(null)}
                    >
                      <StepDetail
                        doc={doc}
                        step={st}
                        locked={running}
                        onRemove={() => updateFlow(path, (f) => ({ ...f, steps: f.steps.filter((s) => s.id !== st.id) }))}
                      />
                    </StepRow>
                  ))}
                </div>
              )}
              <AddRequest doc={doc} onAdded={(id) => setOpenId(id)} />
            </div>
          </div>
        </div>
        {panel === "env" && <EnvPanel onClose={() => setPanel(null)} />}
        {panel === "history" && <HistoryPanel path={path} onClose={() => setPanel(null)} />}
      </div>
    </>
  );
}

function RunSummary({ doc }: { doc: FlowDoc }) {
  const run = useFlows((s) => s.runs[doc.path]);
  const responses = useFlows((s) => s.responses);
  if (!run) return null;
  const outs = doc.steps.map((s) => responses[rk(doc.path, s.id)]);
  const total = outs.reduce((a, o) => a + (o?.res?.totalMs ?? 0), 0);
  const done = outs.filter((o) => o?.state === "passed").length;
  const failAt = outs.findIndex((o) => o?.state === "failed" || o?.state === "error");
  const [tone, text]: [Shown, string] =
    run.status === "running"
      ? ["starting", `Running ${Math.min(done + 1, doc.steps.length)} of ${doc.steps.length}`]
      : run.status === "cancelled"
        ? ["stopped", "Stopped"]
        : run.status === "failed"
          ? ["crashed", `Failed at request ${failAt + 1} · ${formatMs(total)}`]
          : ["running", `${doc.steps.length} of ${doc.steps.length} passed · ${formatMs(total)}`];
  return (
    <span className={cx("flex min-w-0 flex-none items-center gap-1.5 truncate text-sm", STATUS_TEXT[tone])}>
      <StatusMark status={tone} size={9} /> {text}
    </span>
  );
}

/* ---------------- service map ---------------- */

function ServiceMap({ doc, openId, height, setHeight }: { doc: FlowDoc; openId: string | null; height: number; setHeight: (h: number) => void }) {
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
    (run?.status === "running" ? doc.steps.find((s) => ["sending", "polling"].includes(responses[rk(doc.path, s.id)]?.state ?? "")) : undefined) ??
    doc.steps.find((s) => s.id === openId);
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
            ? `Path of request ${doc.steps.indexOf(focusStep) + 1}${trace?.hops.some((h) => h.approx) ? " · ≈ times from logs" : ""}`
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

/* ---------------- rows ---------------- */

const STATE_MARK: Record<string, Shown> = {
  queued: "queued",
  sending: "starting",
  polling: "starting",
  passed: "running",
  failed: "crashed",
  error: "crashed",
  skipped: "stopped",
  cancelled: "stopped",
};

function StepRow({
  path,
  n,
  step,
  open,
  locked,
  onToggle,
  children,
  dragging,
  onDragStart,
  onDragEnter,
  onDragEnd,
}: {
  path: string;
  n: number;
  step: FlowStep;
  open: boolean;
  locked: boolean;
  onToggle: () => void;
  children: ReactNode;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
}) {
  const out = useFlows((s) => s.responses[rk(path, step.id)]);
  const r = out?.res;
  const mark = out ? STATE_MARK[out.state] : undefined;
  return (
    <div className={cx("border-b border-line last:border-b-0", dragging && "opacity-50")} onDragEnter={onDragEnter} onDragOver={(e) => e.preventDefault()}>
      <div className={cx("group flex h-11 items-center gap-3 pr-3 pl-1 transition-colors", open ? "bg-surface-2" : "bg-surface hover:bg-surface-2")}>
        <span
          draggable={!locked}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          className={cx(
            "grid h-8 w-5 flex-none place-items-center text-fg-3 opacity-0",
            !locked && "cursor-grab group-hover:opacity-100 active:cursor-grabbing",
          )}
          aria-label="Drag to reorder"
          title="Drag to reorder"
        >
          <GripVertical className="size-3.5" />
        </span>
        <button onClick={onToggle} aria-expanded={open} className="flex h-full min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronRight className={cx("size-3.5 flex-none text-fg-3 transition-transform", open && "rotate-90")} />
          <span className="w-5 flex-none font-mono text-xs text-fg-3 tabular-nums">{n}</span>
          <MethodBadge method={step.method} />
          <span className="flex-none text-base font-medium">{step.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{step.url}</span>
          {step.body.kind === "file" && (step.body.file.startsWith("/") || step.body.file.split("/").includes("..")) && (
            <span className="flex-none rounded bg-warm/15 px-1.5 text-xs text-warm" title={`Sends ${step.body.file}, which is outside the workspace`}>
              file outside workspace
            </span>
          )}
          {step.poll && <span className="flex-none rounded bg-surface-3 px-1.5 text-xs text-fg-2">poll</span>}
          {step.extract.some((e) => e.key.trim()) && (
            <span className="max-w-40 flex-none truncate rounded bg-surface-3 px-1.5 text-xs text-fg-2">
              →{" "}
              {step.extract
                .filter((e) => e.key.trim())
                .map((e) => e.key)
                .join(", ")}
            </span>
          )}
          {out?.state === "polling" && <span className="flex-none font-mono text-xs text-warm">try {out.tries}</span>}
          {out?.state === "skipped" && <span className="flex-none text-xs text-fg-3">skipped</span>}
          {out?.state === "error" && <span className="flex-none text-xs text-bad-soft">not sent</span>}
          {r && <span className={cx("flex-none font-mono text-xs font-semibold", r.status < 400 ? "text-ok" : "text-bad")}>{r.status}</span>}
          {r && <span className="w-14 flex-none text-right font-mono text-xs text-fg-3">{formatMs(r.totalMs)}</span>}
          {mark && <StatusMark status={mark} size={10} className={STATUS_TEXT[mark]} />}
        </button>
      </div>
      {open && children}
    </div>
  );
}

/* ---------------- request | response ---------------- */

type ReqTab = "body" | "headers" | "extract" | "checks" | "poll" | "curl";
const BODY_KINDS: { id: BodyKind; label: string }[] = [
  { id: "none", label: "None" },
  { id: "json", label: "JSON" },
  { id: "text", label: "Text" },
  { id: "form", label: "Form" },
  { id: "file", label: "File" },
];

function useServiceColors(doc: FlowDoc) {
  const services = useStore(selectServices);
  return useMemo(() => {
    const m: Record<string, number> = Object.fromEntries(services.map((s) => [s.name, s.color]));
    for (const f of doc.services) {
      const svc = services.find((s) => s.id === serviceIdFor(f.ref));
      if (svc) m[f.alias] = svc.color;
    }
    return m;
  }, [services, doc.services]);
}

function StepDetail({ doc, step, locked, onRemove }: { doc: FlowDoc; step: FlowStep; locked: boolean; onRemove: () => void }) {
  const path = doc.path;
  const out = useFlows((s) => s.responses[rk(path, step.id)]);
  const invalid = useFlows((s) => s.invalid[rk(path, step.id)]);
  const extracted = useFlows((s) => s.extracted[path]);
  useFlows((s) => s.envs);
  useStore((s) => s.runtime);
  const colors = useServiceColors(doc);
  const src = varSources(doc, extracted);
  const [tab, setTab] = useState<ReqTab>(step.body.kind !== "none" ? "body" : "headers");
  const busy = out?.state === "sending" || out?.state === "polling";
  const patch = (p: Partial<FlowStep>) => updateStep(path, step.id, p);
  const preview = resolveHidingSecrets(step.url, src);
  const missing = resolve(step.url, src).missing;
  const fromEarlier = missing.filter((m) => doc.steps.some((s) => s.id !== step.id && s.extract.some((e) => e.key === m)));

  return (
    // Side by side when there's room; stacked when a side panel narrows the view.
    <div className="@container border-t border-line bg-bg">
      <div className="grid grid-cols-1 divide-y divide-line @[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @[860px]:divide-x @[860px]:divide-y-0">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 px-3 pt-3">
            <input
              className="h-7 min-w-0 flex-1 rounded px-1.5 text-base font-semibold outline-none hover:bg-surface-2 focus:bg-rail"
              value={step.name}
              onChange={(e) => patch({ name: e.target.value })}
              aria-label="Request name"
            />
            <IconButton label="Delete request" onClick={onRemove} disabled={locked}>
              <Trash2 />
            </IconButton>
          </div>
          <div className="flex items-center gap-2 p-3">
            <div className="flex min-w-0 flex-1 items-center rounded-md border border-line-strong bg-rail focus-within:border-paper/70">
              <select
                className="h-8 flex-none appearance-none rounded-l-md bg-transparent pr-6 pl-2.5 font-mono text-xs font-semibold"
                style={{ color: METHOD_COLOR[step.method] }}
                value={step.method}
                onChange={(e) => patch({ method: e.target.value })}
                aria-label="Method"
              >
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <span className="h-5 w-px bg-line-strong" aria-hidden />
              <VarInput
                value={step.url}
                onChange={(url) => patch({ url })}
                src={src}
                serviceColors={colors}
                placeholder="{{service}}/path"
                label="URL"
                onEnter={() => !locked && void sendStep(path, step)}
              />
            </div>
            {busy ? (
              <Button className="h-8" onClick={() => cancelStep(path, step.id)} disabled={locked}>
                <Square /> Cancel
              </Button>
            ) : (
              <Button variant="primary" className="h-8" onClick={() => void sendStep(path, step)} disabled={!step.url.trim() || locked}>
                <Play /> Send
              </Button>
            )}
          </div>
          <div className={cx("-mt-1 truncate px-3 pb-2 font-mono text-xs", missing.length ? "text-warm" : "text-fg-3")} title={preview}>
            {step.url ? preview : "Type a URL, or start with {{service-name}}"}
            {missing.length > 0 &&
              (fromEarlier.length === missing.length ? "  · filled in by an earlier request" : `  · no value for ${missing.map((m) => `{{${m}}}`).join(", ")}`)}
          </div>
          <Tabs
            tabs={[
              { id: "body", label: "Body", dot: !!invalid },
              { id: "headers", label: "Headers", count: step.headers.filter((h) => h.key.trim()).length },
              { id: "extract", label: "Extract", count: step.extract.filter((e) => e.key.trim()).length },
              { id: "checks", label: "Checks", count: step.checks.filter((c) => c.left.trim()).length },
              { id: "poll", label: step.poll ? "Poll · on" : "Poll" },
              { id: "curl", label: "curl" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <div className="h-[340px] overflow-y-auto p-3">
            {tab === "body" && <BodyEditor path={path} step={step} invalid={invalid} />}
            {tab === "headers" && (
              <KVTable
                rows={step.headers}
                onChange={(headers) => patch({ headers })}
                keyPh="Header"
                valPh="Value · {{variables}} work here"
                hint={doc.injectHeaders ? "Auxin also adds X-Request-ID and traceparent so it can trace this request through your services' logs." : undefined}
              />
            )}
            {tab === "extract" && (
              <KVTable
                rows={step.extract}
                onChange={(extract) => patch({ extract })}
                keyPh="variable, e.g. jobId"
                valPh="body.jobId · header.location · body.items[0].id"
                hint={
                  <>
                    Each value becomes <span className="font-mono">{"{{variable}}"}</span> for the requests after this one.
                  </>
                }
              />
            )}
            {tab === "checks" && (
              <ChecksEditor
                checks={step.checks}
                onChange={(checks) => patch({ checks })}
                empty="With no checks, the request passes when the status is below 400."
              />
            )}
            {tab === "poll" && <PollEditor step={step} onChange={(poll) => patch({ poll })} />}
            {tab === "curl" && <CurlExport doc={doc} step={step} />}
          </div>
        </div>
        <ResponsePanel doc={doc} out={out} onCancel={() => cancelStep(path, step.id)} />
      </div>
    </div>
  );
}

function ChecksEditor({ checks, onChange, empty }: { checks: Check[]; onChange: (c: Check[]) => void; empty?: string }) {
  const cell = "h-8 w-full bg-transparent px-2.5 font-mono text-sm text-fg outline-none placeholder:text-fg-3 focus:bg-rail";
  return (
    <div className="grid gap-2">
      <div className="overflow-hidden rounded-md border border-line">
        {checks.map((c, i) => {
          const set = (p: Partial<Check>) => onChange(checks.map((x, j) => (j === i ? { ...x, ...p } : x)));
          const unary = c.op === "exists" || c.op === "!exists";
          return (
            <div key={i} className="group grid grid-cols-[minmax(0,2fr)_112px_minmax(0,2fr)_28px] divide-x divide-line border-b border-line">
              <input
                className={cell}
                value={c.left}
                placeholder="status · body.status · time"
                onChange={(e) => set({ left: e.target.value })}
                aria-label="What to check"
                spellCheck={false}
              />
              <select
                className="h-8 appearance-none bg-transparent px-2 font-mono text-sm text-fg outline-none focus:bg-rail"
                value={c.op}
                onChange={(e) => set({ op: e.target.value as CheckOp })}
                aria-label="Operator"
              >
                {CHECK_OPS.map((op) => (
                  <option key={op}>{op}</option>
                ))}
              </select>
              <input
                className={cell}
                value={unary ? "" : c.right}
                disabled={unary}
                placeholder={unary ? "" : '200 · "done" · true'}
                onChange={(e) => set({ right: e.target.value })}
                aria-label="Expected value"
                spellCheck={false}
              />
              <button
                className="grid place-items-center text-fg-3 opacity-0 group-hover:opacity-100 hover:text-bad-soft focus-visible:opacity-100"
                onClick={() => onChange(checks.filter((_, j) => j !== i))}
                aria-label="Remove check"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
        <button
          className="flex h-8 w-full items-center gap-1.5 px-2.5 text-sm text-fg-3 hover:bg-surface-2 hover:text-fg-2"
          onClick={() => onChange([...checks, { left: checks.length ? "" : "status", op: "==", right: checks.length ? "" : "200" }])}
        >
          <Plus className="size-3.5" /> Add check
        </button>
      </div>
      <span className="text-xs text-fg-3">{checks.length ? "If a check fails, the flow stops here and later requests are skipped." : empty}</span>
    </div>
  );
}

function PollEditor({ step, onChange }: { step: FlowStep; onChange: (p: FlowStep["poll"]) => void }) {
  const p = step.poll;
  return (
    <div className="grid gap-3 text-sm">
      <label className="flex items-center gap-2 text-fg-2">
        <input
          type="checkbox"
          checked={!!p}
          onChange={(e) => onChange(e.target.checked ? { until: [{ left: "body.status", op: "==", right: '"done"' }], everyMs: 1000, maxTries: 30 } : null)}
        />
        Repeat this request until a condition holds
      </label>
      {p && (
        <>
          <ChecksEditor checks={p.until} onChange={(until) => onChange({ ...p, until })} />
          <div className="flex flex-wrap items-center gap-2 text-fg-2">
            Every
            <input
              className={cx(inputClass, "h-8 w-20 font-mono text-sm")}
              type="number"
              min={0.1}
              step={0.5}
              value={p.everyMs / 1000}
              onChange={(e) => onChange({ ...p, everyMs: Math.max(100, Math.round(Number(e.target.value) * 1000) || 1000) })}
              aria-label="Seconds between tries"
            />
            seconds, at most
            <input
              className={cx(inputClass, "h-8 w-20 font-mono text-sm")}
              type="number"
              min={1}
              value={p.maxTries}
              onChange={(e) => onChange({ ...p, maxTries: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
              aria-label="Maximum tries"
            />
            tries.
          </div>
        </>
      )}
    </div>
  );
}

function BodyEditor({ path, step, invalid }: { path: string; step: FlowStep; invalid?: string }) {
  const root = useFlows((s) => s.root);
  const patchBody = (p: Partial<FlowStep["body"]>) => updateStep(path, step.id, { body: { ...step.body, ...p } });
  const [filePreview, setFilePreview] = useState<{ text: string; size: number } | string | null>(null);

  useEffect(() => {
    if (step.body.kind !== "file" || !step.body.file || !root) return setFilePreview(null);
    const abs = step.body.file.startsWith("/") ? step.body.file : `${root}/${step.body.file}`;
    api
      .filePreview(abs)
      .then(([text, size]) => setFilePreview({ text, size }))
      .catch((e) => setFilePreview(String(e)));
  }, [step.body.kind, step.body.file, root]);

  const chooseFile = async () => {
    const picked = await openDialog({ multiple: false, directory: false, defaultPath: root ?? undefined, title: "Choose a body file" });
    if (typeof picked !== "string") return;
    patchBody({ file: root && picked.startsWith(root + "/") ? picked.slice(root.length + 1) : picked });
  };

  return (
    <div className="grid h-full grid-rows-[auto_1fr] gap-2">
      <div className="flex items-center gap-2">
        <Seg label="Body type">
          {BODY_KINDS.map((k) => (
            <SegButton key={k.id} active={step.body.kind === k.id} onClick={() => patchBody({ kind: k.id })}>
              {k.label}
            </SegButton>
          ))}
        </Seg>
        {invalid && <span className="truncate text-xs text-warm">{invalid}</span>}
      </div>
      {step.body.kind === "none" && <p className="text-sm text-fg-3">This request has no body.</p>}
      {(step.body.kind === "json" || step.body.kind === "text") && (
        <textarea
          className={cx(
            "h-full w-full resize-none rounded-md border bg-rail p-3 font-mono text-sm leading-5 text-fg outline-none focus:border-paper/70",
            invalid ? "border-warm/60" : "border-line",
          )}
          value={step.body.text}
          onChange={(e) => patchBody({ text: e.target.value })}
          placeholder={step.body.kind === "json" ? '{\n  "key": "value",\n  "id": "{{jobId}}"\n}' : "Plain text body"}
          spellCheck={false}
          aria-label="Body"
        />
      )}
      {step.body.kind === "form" && (
        <KVTable rows={step.body.form} onChange={(form) => patchBody({ form })} keyPh="field" valPh="value" hint="Sent as application/x-www-form-urlencoded." />
      )}
      {step.body.kind === "file" && (
        <div className="grid content-start gap-2">
          <div className="flex gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-rail px-2.5 font-mono text-sm text-fg outline-none focus:border-paper/70"
              value={step.body.file}
              onChange={(e) => patchBody({ file: e.target.value })}
              placeholder="path/relative/to/workspace.json"
              aria-label="Body file"
              spellCheck={false}
            />
            <Button className="h-8" onClick={() => void chooseFile()}>
              <FolderOpen /> Choose…
            </Button>
          </div>
          <span className="text-xs text-fg-3">
            Sent as-is (variables in the file aren't replaced). Paths are relative to the workspace, so teammates can use the same flow.
          </span>
          {(step.body.file.startsWith("/") || step.body.file.split("/").includes("..")) && (
            <span className="text-xs text-warm">This file is outside the workspace. Check it's meant to be sent, especially in a flow you got from someone else.</span>
          )}
          {typeof filePreview === "string" && <span className="text-xs text-bad-soft">{filePreview}</span>}
          {filePreview && typeof filePreview === "object" && (
            <div className="overflow-hidden rounded-md border border-line">
              <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs text-fg-3">
                <FileJson className="size-3.5" /> {formatBytes(filePreview.size)}
                {filePreview.size > filePreview.text.length && " · showing the start"}
              </div>
              <pre className="max-h-48 overflow-auto p-3 font-mono text-xs text-fg-2 select-text">{filePreview.text}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CurlExport({ doc, step }: { doc: FlowDoc; step: FlowStep }) {
  const extracted = useFlows((s) => s.extracted[doc.path]);
  const src = varSources(doc, extracted);
  const root = useFlows((s) => s.root);
  const build = (withSecrets: boolean) => {
    const sub = (t: string) => (withSecrets ? resolve(t, src).text : resolveHidingSecrets(t, src));
    const body =
      step.body.kind === "json" || step.body.kind === "text"
        ? sub(step.body.text)
        : step.body.kind === "form"
          ? step.body.form.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(sub(f.value))}`).join("&")
          : step.body.kind === "file" && step.body.file
            ? `@${step.body.file.startsWith("/") ? step.body.file : `${root}/${step.body.file}`}`
            : "";
    return toCurl({ method: step.method, url: sub(step.url), headers: step.headers.filter((h) => h.key.trim()).map((h) => [h.key, sub(h.value)]), body });
  };
  const copy = async (withSecrets: boolean) => {
    await navigator.clipboard?.writeText(build(withSecrets));
    toast(
      "info",
      withSecrets ? "Copied with secrets filled in" : "Copied as curl",
      withSecrets ? "Careful where you paste it." : "Secrets stay as {{placeholders}}.",
    );
  };
  return (
    <div className="grid gap-2">
      <pre className="overflow-x-auto rounded-md border border-line bg-rail p-3 font-mono text-sm text-fg-2 select-text">{build(false)}</pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void copy(false)}>
          <Copy /> Copy as curl
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copy(true)}>
          Copy with secrets
        </Button>
      </div>
    </div>
  );
}

/* ---------------- response ---------------- */

function ResponsePanel({ doc, out, onCancel }: { doc: FlowDoc; out?: StepOutcome; onCancel: () => void }) {
  const hasTrace = !!out?.trace || !!out?.tracing;
  const [tab, setTab] = useState<"trace" | "body" | "headers" | "request">("body");
  // Switch to the trace once per response, when it appears; then leave the choice to the user.
  const switchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (hasTrace && out && switchedFor.current !== out.reqId) {
      switchedFor.current = out.reqId;
      setTab("trace");
    }
  }, [hasTrace, out?.reqId]); // eslint-disable-line react-hooks/exhaustive-deps
  const services = useStore(selectServices);
  const runtime = useStore((s) => s.runtime);

  const center = (children: ReactNode) => <div className="grid min-w-0 content-center justify-items-center gap-3 p-8 text-center">{children}</div>;

  if (!out)
    return center(
      <span className="grid justify-items-center gap-2 text-sm text-fg-3">
        <Play className="size-5 text-fg-3/60" />
        Send this request to see the response here.
      </span>,
    );
  if (out.state === "queued") return center(<span className="text-sm text-fg-3">Waiting for the earlier requests…</span>);
  if (out.state === "skipped") return center(<span className="text-sm text-fg-3">Skipped because an earlier request didn't pass.</span>);
  if ((out.state === "sending" || out.state === "polling") && !out.res)
    return center(
      <>
        <StatusMark status="starting" size={14} className="text-warm" />
        <span className="font-mono text-xs break-all text-fg-3">
          {out.method} {out.url}
        </span>
        {out.state === "polling" && <span className="text-sm text-fg-2">Polling · try {out.tries}</span>}
        <Button size="sm" onClick={onCancel}>
          <Square /> Cancel
        </Button>
      </>,
    );
  if (out.state === "error" || (out.state === "cancelled" && !out.res)) {
    const owner = out.missingService
      ? (services.find((s) => s.name === out.missingService) ??
        services.find((s) => s.id === serviceIdFor(doc.services.find((f) => f.alias === out.missingService)?.ref ?? "")))
      : out.refusedPort
        ? services.find((s) => (runtime[s.id]?.port ?? s.portHint) === out.refusedPort)
        : undefined;
    return center(
      <>
        <span className="max-w-[440px] text-sm text-bad-soft select-text">{out.error}</span>
        {owner && runtime[owner.id]?.status !== "running" && (
          <Button size="sm" variant="primary" onClick={() => void startService(owner.id)}>
            <Play /> Start {owner.name}
          </Button>
        )}
        <span className="font-mono text-xs break-all text-fg-3">
          {out.method} {out.url}
        </span>
      </>,
    );
  }

  const r = out.res!;
  const failedChecks = out.checks.filter((c) => !c.ok);
  const badHop = out.trace?.hops.some((h) => !h.ok);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3 pb-2">
        <span className={cx("rounded px-2 py-0.5 font-mono text-sm font-semibold", r.status < 400 ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad")}>
          {r.status} {r.statusText}
        </span>
        <span className="font-mono text-sm text-fg-2" title={`First byte after ${formatMs(r.firstByteMs)}`}>
          {formatMs(r.totalMs)}
        </span>
        <span className="font-mono text-sm text-fg-3">{formatBytes(r.size)}</span>
        {(out.tries ?? 0) > 1 && <span className="font-mono text-sm text-fg-3">{out.tries} tries</span>}
        <span className="flex-1" />
        {out.state === "polling" && <span className="font-mono text-sm text-warm">polling · try {out.tries}</span>}
        {out.checks.length > 0 && (
          <span className={cx("text-sm", failedChecks.length ? "text-bad-soft" : "text-ok")}>
            {out.checks.length - failedChecks.length}/{out.checks.length} checks
          </span>
        )}
        {r.bodyText != null && (
          <IconButton size="sm" label="Copy response body" onClick={() => void navigator.clipboard?.writeText(r.bodyText!)}>
            <Copy />
          </IconButton>
        )}
      </div>
      {(out.extracted.length > 0 || failedChecks.length > 0) && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
          {out.extracted.map((e) => (
            <span key={e.key} className="max-w-full truncate rounded bg-surface-3 px-1.5 font-mono text-xs text-fg" title={e.value}>
              {`{{${e.key}}}`} = {e.value}
            </span>
          ))}
          {failedChecks.map((c) => (
            <span key={c.label} className="flex items-center gap-1 rounded bg-bad/10 px-1.5 font-mono text-xs text-bad-soft">
              <X className="size-3" /> {c.label} · got {c.got}
            </span>
          ))}
        </div>
      )}
      <Tabs
        tabs={[
          { id: "trace", label: "Trace", count: out.trace?.lines.length, dot: badHop },
          { id: "body", label: "Response" },
          { id: "headers", label: "Headers", count: r.headers.length },
          { id: "request", label: "Request" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="h-[340px] overflow-y-auto">
        {tab === "trace" && <TraceView out={out} injected={doc.injectHeaders} />}
        {tab === "body" && <ResponseBody out={out} />}
        {tab === "headers" && <HeaderList rows={r.headers} />}
        {tab === "request" && (
          <div className="grid gap-3 px-4 py-3">
            <div className="font-mono text-sm break-all text-fg select-text">
              <span style={{ color: METHOD_COLOR[out.method] }}>{out.method}</span> {out.url}
            </div>
            <HeaderList rows={out.headers} bare />
          </div>
        )}
      </div>
    </div>
  );
}

const MATCH_HELP = {
  "request-id": "Auxin added this id to the request; services that log or forward it match exactly.",
  value: "A value from the request or response (like a job id) found in other services' logs.",
};

function TraceView({ out, injected }: { out: StepOutcome; injected: boolean }) {
  const [only, setOnly] = useState<string | null>(null);
  const [showNearby, setShowNearby] = useState(false);
  const services = useStore(selectServices);
  const colorOf = (id: string) => SERVICE_COLORS[services.find((s) => s.id === id)?.color ?? 9];
  if (out.tracing || !out.trace)
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-fg-3">
        <span className="grid justify-items-center gap-2">
          <StatusMark status="starting" size={12} className="text-warm" />
          Collecting log lines from your services…
        </span>
      </div>
    );
  const t = out.trace;
  const pick = (ls: TraceLine[]) => (only ? ls.filter((l) => l.service === only) : ls);
  const lines = showNearby ? [...pick(t.lines), ...pick(t.nearby)].sort((a, b) => a.ts - b.ts) : pick(t.lines);
  const t0 = Math.min(out.sentAt, lines[0]?.ts ?? out.sentAt);
  const total = Math.max(1, ...t.hops.map((h) => h.ms));

  return (
    <div>
      {t.hops.length > 0 && (
        <div className="grid gap-1 border-b border-line px-4 py-3">
          {t.hops.map((h, i) => (
            <button
              key={h.service}
              onClick={() => setOnly(only === h.service ? null : h.service)}
              aria-pressed={only === h.service}
              className={cx(
                "grid grid-cols-[minmax(0,170px)_1fr_72px] items-center gap-3 rounded px-1 py-0.5 text-left text-sm transition-colors hover:bg-surface-2",
                only === h.service && "bg-surface-2",
              )}
              title={only === h.service ? "Show every service" : "Show only this service's lines"}
            >
              <span className={cx("flex min-w-0 items-center gap-1.5", h.ok ? "text-fg" : "text-bad-soft")}>
                {i > 0 && <ArrowRight className="size-3 flex-none text-fg-3" aria-hidden />}
                <span className="h-3 w-[3px] flex-none rounded-full" style={{ background: colorOf(h.service) }} aria-hidden />
                <span className="truncate">{h.alias}</span>
              </span>
              <span className="relative h-2 rounded-full bg-surface-3">
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${Math.max(2, (h.ms / total) * 100)}%`, background: h.ok ? colorOf(h.service) : "var(--color-bad)" }}
                />
              </span>
              <span
                className={cx("text-right font-mono text-xs", h.ok ? "text-fg-3" : "text-bad-soft")}
                title={h.approx ? "From the first to the last matching log line (approximate)" : "Measured response time"}
              >
                {h.approx ? "≈" : ""}
                {formatMs(h.ms)}
              </span>
            </button>
          ))}
        </div>
      )}
      {lines.length ? (
        <div className="py-1.5 font-mono text-sm leading-[18px] select-text">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cx("flex gap-3 px-4", l.level === "error" && "bg-bad/[0.08]", l.level === "warn" && "bg-warm/[0.06]", l.tier === 3 && "opacity-55")}
            >
              <span className="w-16 flex-none text-right text-fg-3/80 tabular-nums" title={formatClock(l.ts)}>
                +{l.ts - t0}ms
              </span>
              <span className="w-28 flex-none truncate font-semibold" style={{ color: colorOf(l.service) }} title={l.alias}>
                {l.alias}
              </span>
              <span
                className={cx(
                  "min-w-0 break-all whitespace-pre-wrap",
                  l.level === "error" ? "text-bad-soft" : l.level === "warn" ? "text-[#e9c98f]" : "text-fg",
                )}
              >
                {highlight(l.text, l.match)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-4 py-4 text-sm text-fg-3">
          No log lines matched this request.{" "}
          {injected
            ? "Services that log the X-Request-ID header, or ids from the request and response, show up here."
            : "Trace headers are off for this flow, so only ids from the request and response can match."}
          {t.nearby.length > 0 && " Try “Show nearby lines”."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-2 text-xs text-fg-3">
        {t.matchedBy.length ? "Matched by" : "Nothing matched"}
        {t.matchedBy.map((m) => (
          <span key={m.label} className="max-w-60 truncate rounded bg-surface-3 px-1.5 font-mono text-fg-2" title={MATCH_HELP[m.kind]}>
            {m.label}
          </span>
        ))}
        <span className="flex-1" />
        {t.nearby.length > 0 && (
          <button className="text-fg-2 hover:text-fg" onClick={() => setShowNearby((v) => !v)} aria-pressed={showNearby}>
            {showNearby ? "Hide" : "Show"} nearby lines ({t.nearby.length})
          </button>
        )}
      </div>
      {t.unavailable.length > 0 && (
        <p className="px-4 pb-3 text-xs text-fg-3">
          Logs not available for {t.unavailable.join(", ")}: start {t.unavailable.length > 1 ? "them" : "it"} from Auxin to trace through{" "}
          {t.unavailable.length > 1 ? "them" : "it"}.
        </p>
      )}
    </div>
  );
}

function highlight(text: string, needle?: string): ReactNode {
  if (!needle) return text;
  const i = text.indexOf(needle);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{needle}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

function HeaderList({ rows, bare }: { rows: [string, string][]; bare?: boolean }) {
  return (
    <div className={cx("grid gap-1 font-mono text-sm", !bare && "px-4 py-3")}>
      {rows.map(([k, v], i) => (
        <div key={k + i} className="flex gap-3">
          <span className="w-44 flex-none truncate text-fg-3">{k}</span>
          <span className="min-w-0 break-all text-fg select-text">{v}</span>
        </div>
      ))}
      {!rows.length && <span className="text-fg-3">No headers.</span>}
    </div>
  );
}

function ResponseBody({ out }: { out: StepOutcome }) {
  const r = out.res!;
  const type = (r.contentType ?? "").toLowerCase();
  const pretty = useMemo(() => {
    if (r.bodyText == null) return null;
    const t = r.bodyText.trim();
    if (type.includes("json") || /^[[{]/.test(t)) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return null;
      }
    }
    return null;
  }, [r.bodyText, type]);

  return (
    <div>
      {r.truncated && (
        <div className="flex items-center gap-2 border-b border-line bg-warm/10 px-4 py-2 text-xs text-fg-2">
          Showing the first 10 MB of {formatBytes(r.size)}.
          {r.fullBodyPath && (
            <button className="underline underline-offset-2 hover:text-fg" onClick={() => void revealItemInDir(r.fullBodyPath!)}>
              Show full response in Finder
            </button>
          )}
        </div>
      )}
      {pretty != null ? (
        <pre className="px-4 py-3 font-mono text-sm leading-[18px] select-text">
          <Json text={pretty} />
        </pre>
      ) : r.bodyText != null ? (
        r.bodyText ? (
          <pre className="px-4 py-3 font-mono text-sm leading-[18px] break-all whitespace-pre-wrap text-fg select-text">{r.bodyText}</pre>
        ) : (
          <p className="px-4 py-3 text-sm text-fg-3">Empty body.</p>
        )
      ) : type.startsWith("image/") && r.bodyBase64 ? (
        <div className="p-4">
          <img src={`data:${type};base64,${r.bodyBase64}`} alt="Response image" className="max-h-72 rounded border border-line" />
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-fg-3">
          Binary response ({r.contentType ?? "unknown type"}, {formatBytes(r.size)}).
        </p>
      )}
    </div>
  );
}

/* ---------------- adding requests ---------------- */

function AddRequest({ doc, onAdded }: { doc: FlowDoc; onAdded: (id: string) => void }) {
  const empty = doc.steps.length === 0;
  const [mode, setMode] = useState<"closed" | "curl">(empty ? "curl" : "closed");
  const [text, setText] = useState("");
  const envs = useFlows((s) => s.envs);
  const envName = activeEnvName();
  const area = useRef<HTMLTextAreaElement>(null);

  const parsed = useMemo(() => (text.trim() ? parseCurl(text) : null), [text]);
  const plan = useMemo(() => {
    if (!parsed) return null;
    const t = templatize({ url: parsed.url, headers: parsed.headers }, servicePorts(doc).portToService, envs[envName]?.secrets ?? {});
    return { ...parsed, ...t };
  }, [parsed, envs, envName, doc]);

  const add = (step: FlowStep) => {
    updateFlow(doc.path, (f) => ({ ...f, steps: [...f.steps, step] }));
    onAdded(step.id);
  };

  const addFromCurl = async () => {
    if (!plan) return;
    if (Object.keys(plan.newSecrets).length) {
      const env = envs[envName] ?? { name: envName, vars: {}, baseUrls: {}, insecureTls: false, secrets: {} };
      await saveEnv({ ...env, secrets: { ...env.secrets, ...plan.newSecrets } });
    }
    let kind: BodyKind = "none";
    let bodyText = plan.body;
    if (plan.body) {
      try {
        bodyText = JSON.stringify(JSON.parse(plan.body), null, 2);
        kind = "json";
      } catch {
        kind = "text";
      }
    }
    // Name it after the path, skipping ids (uuids, numbers, hashes): "PATCH module/v2".
    const isId = (seg: string) => /^[0-9a-f-]{8,}$/i.test(seg) || /^\d+$/.test(seg) || seg.includes("{{");
    const last = plan.url
      .replace(/^\{\{[^}]+\}\}/, "")
      .split("?")[0]
      .split("/")
      .filter((x) => x && !isId(x))
      .slice(-2)
      .join("/");
    add({
      ...blankStep(doc.steps.length + 1, plan.url),
      name: `${plan.method} ${last || "request"}`.slice(0, 40),
      method: plan.method,
      headers: plan.headers.map(([key, value]) => ({ key, value })),
      body: { kind, text: kind === "none" ? "" : bodyText, form: [], file: "" },
    });
    setText("");
    setMode("closed");
  };

  if (mode === "closed")
    return (
      <div className="mt-3 flex gap-2">
        <Button onClick={() => add(blankStep(doc.steps.length + 1, ""))}>
          <Plus /> New request
        </Button>
        <Button
          onClick={() => {
            setMode("curl");
            setTimeout(() => area.current?.focus(), 0);
          }}
        >
          <ClipboardPaste /> Paste curl
        </Button>
      </div>
    );

  return (
    <div className={cx("grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 rounded-lg border border-line bg-surface p-4", empty ? "mt-6" : "mt-3")}>
      <div className="grid content-start gap-2">
        <span className="text-sm font-semibold text-fg">{empty ? "Start with a request" : "Paste a curl command"}</span>
        {empty && (
          <span className="text-sm text-fg-3">Paste a curl from your terminal, API docs or a browser's “Copy as cURL”, or start from a blank request.</span>
        )}
        <textarea
          ref={area}
          autoFocus={!empty}
          className="h-44 w-full resize-none rounded-md border border-line bg-rail p-3 font-mono text-sm leading-5 text-fg outline-none placeholder:text-fg-3 focus:border-paper/70"
          placeholder={`curl --request PATCH \\\n  --url http://localhost:4000/... \\\n  --header 'content-type: application/json' \\\n  --data '{"path":"settings.retries","value":3}'`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label="curl command"
        />
      </div>
      <div className="grid content-start gap-2">
        <span className="text-sm font-semibold text-fg-2">Preview</span>
        {!text.trim() && <p className="text-sm text-fg-3">The method, URL, headers and body appear here as you paste.</p>}
        {text.trim() && !plan && <p className="text-sm text-bad-soft">That doesn't look like a curl command. It should start with curl and include a URL.</p>}
        {plan && (
          <div className="grid gap-2 rounded-md border border-line bg-bg p-3">
            <div className="flex min-w-0 items-center gap-2">
              <MethodBadge method={plan.method} />
              <span className="truncate font-mono text-sm text-fg">{plan.url}</span>
            </div>
            {plan.service && <span className="text-xs text-fg-3">Recognised {plan.service} by its port, so the URL follows the environment.</span>}
            {plan.secretName && Object.keys(plan.newSecrets).length > 0 && (
              <span className="text-xs text-fg-3">
                The Authorization token will be saved as the secret <span className="font-mono text-fg-2">{`{{${plan.secretName}}}`}</span> in “{envName}”
                (git-ignored), not in the flow file.
              </span>
            )}
            <span className="text-xs text-fg-3">
              {plan.headers.length} header{plan.headers.length === 1 ? "" : "s"}
              {plan.body ? ` · body ${formatBytes(plan.body.length)}` : ""}
            </span>
            {plan.warnings?.map((w) => (
              <span key={w} className="text-xs text-warm">
                {w}
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="primary" disabled={!plan} onClick={() => void addFromCurl()}>
            <Plus /> Add request
          </Button>
          {empty ? (
            <Button variant="ghost" onClick={() => add(blankStep(1, ""))}>
              Blank request
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setMode("closed")}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
