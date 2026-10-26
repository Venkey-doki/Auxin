/**
 * A flow: the service map (n8n-style canvas) over the requests, as
 * Linear-style rows that open into an Insomnia-style request | response split
 * with the request's trace. docs/flows-spec.md §7.
 */
import { ChevronRight, ClipboardPaste, GripVertical, History, Play, Plus, Rows3, Settings2, Split, Square, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditableTitle } from "../components/GroupView";
import { StatusMark, STATUS_TEXT, type Shown } from "../components/status";
import { Button, cx, IconButton, TopBar } from "../components/ui";
import { parseCurl } from "../lib/curl";
import { MOD } from "../lib/util";
import { useStore } from "../state/store";
import { EnvPanel } from "./EnvPanel";
import { HistoryPanel } from "./HistoryPanel";
import type { Issue } from "./engine";
import { addToLane, allSteps, blankBlock, blankStep, DEFAULT_NETWORK, moveItem, outsideWorkspace, removeItem, type BodyKind, type FlowBlock, type FlowDoc, type FlowStep, type Lane } from "./model";
import { formatBytes, formatMs, MethodBadge } from "./parts";
import { cancelRun, flowIssues, isRunning, runFlow, sendStep } from "./runner";
import { ServiceMap } from "./ServiceMap";
import { ChecksEditor, StepDetail } from "./StepDetail";
import { activeEnvName, confirmDeleteFlow, rk, saveEnv, servicePorts, setActiveEnv, updateFlow, useFlows } from "./store";
import { templatize } from "./vars";

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
  useStore((s) => s.runtime); // service ports feed {{service}} variables, and so the issues below
  const [openId, setOpenId] = useState<string | null>(null);
  const [panel, setPanel] = useState<"env" | "history" | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [canvasH, setCanvasH] = useState(readCanvasH);
  const steps = useMemo(() => (doc ? allSteps(doc.steps) : []), [doc]);

  // Open the first request once, when the flow is first shown; after that rows stay as the user leaves them.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !steps[0]) return;
    autoOpened.current = true;
    setOpenId(steps[0].id);
  }, [steps]);

  // ⌘↵ sends the open request, ⌘⇧↵ runs the flow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter" || !doc) return;
      e.preventDefault();
      // Held keys auto-repeat; a duplicate POST is never what anyone wants.
      if (e.repeat || isRunning(path)) return;
      if (e.shiftKey) void runFlow(path);
      else {
        const st = steps.find((s) => s.id === openId);
        if (st) void sendStep(path, st);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, steps, openId, path]);

  // While a run is going, keep the request being sent open (the first, when several are in flight).
  const activeStep = run?.status === "running" ? steps.find((s) => ["sending", "polling"].includes(responses[rk(path, s.id)]?.state ?? "")) : undefined;
  useEffect(() => {
    if (activeStep) setOpenId(activeStep.id);
  }, [activeStep?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!loaded) return <div className="grid flex-1 place-items-center text-fg-3">Loading flows…</div>;
  if (!doc) return <div className="grid flex-1 place-items-center text-fg-3">This flow no longer exists in .auxin/flows.</div>;

  const running = run?.status === "running";
  const issues = flowIssues(doc);
  const number = (id: string) => steps.findIndex((s) => s.id === id) + 1;
  // Ids in the order rows appear, so a drag downward lands after its target.
  const order = doc.steps.flatMap((i) => [i.id, ...(i.type === "http" ? [] : allSteps([i]).map((s) => s.id))]);
  const dragTo = (target: string) => {
    if (!dragId || dragId === target) return;
    const down = order.indexOf(dragId) < order.indexOf(target);
    updateFlow(path, (f) => ({ ...f, steps: moveItem(f.steps, dragId, down ? { after: target } : { before: target }) }));
  };
  const dragToLane = (lane: Lane) => dragId && updateFlow(path, (f) => ({ ...f, steps: moveItem(f.steps, dragId, { lane }) }));
  const addTo = (lane: Lane) => {
    const step = blankStep(steps.length + 1, "");
    updateFlow(path, (f) => ({ ...f, steps: addToLane(f.steps, lane, step) }));
    setOpenId(step.id);
  };
  const remove = (id: string) => updateFlow(path, (f) => ({ ...f, steps: removeItem(f.steps, id) }));
  const drag = { dragId, locked: running, onDragStart: setDragId, onDragEnd: () => setDragId(null), dragTo };

  const stepRow = (st: FlowStep, notTaken = false) => (
    <StepRow
      key={st.id}
      path={path}
      n={number(st.id)}
      step={st}
      open={openId === st.id}
      onToggle={() => setOpenId(openId === st.id ? null : st.id)}
      issues={issues.filter((i) => i.id === st.id)}
      notTaken={notTaken}
      {...drag}
    >
      <StepDetail doc={doc} step={st} locked={running} onRemove={() => remove(st.id)} />
    </StepRow>
  );
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
          <Button variant="primary" disabled={!steps.length} onClick={() => void runFlow(path)} title={`Run the flow (${MOD}⇧↵)`}>
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
                  <span className="font-mono text-xs text-fg-3">{steps.length}</span>
                  <span className="flex-1" />
                  <span className="text-xs text-fg-3">
                    <kbd className="font-mono">{MOD}↵</kbd> send · <kbd className="font-mono">{MOD}⇧↵</kbd> run all
                  </span>
                </div>
              )}
              {issues.length > 0 && <IssueStrip doc={doc} issues={issues} number={number} onOpen={setOpenId} />}
              {doc.steps.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-line">
                  {doc.steps.map((item) =>
                    item.type === "http" ? (
                      stepRow(item)
                    ) : (
                      <BlockView
                        key={item.id}
                        path={path}
                        block={item}
                        taken={run?.branches?.[item.id]}
                        issues={issues.filter((i) => i.id === item.id)}
                        onRemove={() => remove(item.id)}
                        onAdd={addTo}
                        onDropLane={dragToLane}
                        stepRow={stepRow}
                        {...drag}
                      />
                    ),
                  )}
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
  const steps = allSteps(doc.steps);
  const outs = steps.map((s) => responses[rk(doc.path, s.id)]);
  const total = outs.reduce((a, o) => a + (o?.res?.totalMs ?? 0), 0);
  const done = outs.filter((o) => o?.state === "passed").length;
  // Requests in a lane that wasn't taken never run; they don't count toward "all passed".
  const ran = outs.filter((o) => o && o.state !== "skipped").length;
  const failAt = outs.findIndex((o) => o?.state === "failed" || o?.state === "error");
  const [tone, text]: [Shown, string] =
    run.status === "running"
      ? ["starting", `Running · ${done} of ${steps.length} passed`]
      : run.status === "cancelled"
        ? ["stopped", "Stopped"]
        : run.status === "failed"
          ? ["crashed", `Failed at request ${failAt + 1} · ${formatMs(total)}`]
          : ["running", `${done} of ${ran} passed · ${formatMs(total)}`];
  return (
    <span className={cx("flex min-w-0 flex-none items-center gap-1.5 truncate text-sm", STATUS_TEXT[tone])}>
      <StatusMark status={tone} size={9} /> {text}
      {run.replayOf && <span className="text-fg-3">· replay</span>}
    </span>
  );
}

/* ---------------- checks before running ---------------- */

/** What would stop the flow from running, found without sending anything. Errors block Run; warnings don't. */
function IssueStrip({ doc, issues, number, onOpen }: { doc: FlowDoc; issues: Issue[]; number: (id: string) => number; onOpen: (id: string) => void }) {
  const errors = issues.filter((i) => i.level === "error").length;
  const [all, setAll] = useState(false);
  const shown = all ? issues : issues.slice(0, 4);
  const label = (id: string) => {
    const n = number(id);
    if (n) return `Request ${n}`;
    return doc.steps.find((i) => i.id === id)?.type === "if" ? "If block" : "Parallel block";
  };
  return (
    <div className={cx("mb-3 rounded-lg border px-3 py-2", errors ? "border-bad/35 bg-bad/[0.06]" : "border-warm/30 bg-warm/[0.05]")} role="status">
      <div className={cx("flex items-center gap-2 text-sm font-semibold", errors ? "text-bad-soft" : "text-warm")}>
        <TriangleAlert className="size-3.5" aria-hidden />
        {errors
          ? `${errors === 1 ? "1 problem" : `${errors} problems`} to fix before running`
          : `${issues.length === 1 ? "1 thing" : `${issues.length} things`} to check`}
      </div>
      <ul className="mt-1 grid">
        {shown.map((i, k) => (
          <li key={i.id + k}>
            <button className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-surface-2" onClick={() => onOpen(i.id)}>
              <span className={cx("flex-none font-medium", i.level === "error" ? "text-fg" : "text-fg-2")}>{label(i.id)}</span>
              <span className="min-w-0 text-fg-2">{i.message}</span>
            </button>
          </li>
        ))}
      </ul>
      {issues.length > 4 && (
        <button className="mt-0.5 px-1 text-xs text-fg-3 hover:text-fg-2" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${issues.length}`}
        </button>
      )}
    </div>
  );
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

interface DragProps {
  dragId: string | null;
  locked: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  /** Moves the dragged row next to `target`. */
  dragTo: (target: string) => void;
}

function Grip({ id, locked, onDragStart, onDragEnd }: Pick<DragProps, "locked" | "onDragStart" | "onDragEnd"> & { id: string }) {
  return (
    <span
      draggable={!locked}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart(id);
      }}
      onDragEnd={onDragEnd}
      className={cx("grid h-8 w-5 flex-none place-items-center text-fg-3 opacity-0", !locked && "cursor-grab group-hover:opacity-100 active:cursor-grabbing")}
      aria-label="Drag to reorder"
      title="Drag to reorder"
    >
      <GripVertical className="size-3.5" />
    </span>
  );
}

function StepRow({
  path,
  n,
  step,
  open,
  onToggle,
  issues,
  notTaken,
  children,
  dragId,
  locked,
  onDragStart,
  onDragEnd,
  dragTo,
}: DragProps & {
  path: string;
  n: number;
  step: FlowStep;
  open: boolean;
  onToggle: () => void;
  issues: Issue[];
  /** In an if lane the last run didn't take. */
  notTaken: boolean;
  children: ReactNode;
}) {
  const out = useFlows((s) => s.responses[rk(path, step.id)]);
  const r = out?.res;
  const mark = out && !(notTaken && out.state === "skipped") ? STATE_MARK[out.state] : undefined;
  const issue = issues.find((i) => i.level === "error") ?? issues[0];
  return (
    <div className={cx("border-b border-line last:border-b-0", dragId === step.id && "opacity-50")} onDragEnter={() => dragTo(step.id)} onDragOver={(e) => e.preventDefault()}>
      <div className={cx("group flex h-11 items-center gap-3 pr-3 pl-1 transition-colors", open ? "bg-surface-2" : "bg-surface hover:bg-surface-2", notTaken && !open && "opacity-60")}>
        <Grip id={step.id} locked={locked} onDragStart={onDragStart} onDragEnd={onDragEnd} />
        <button onClick={onToggle} aria-expanded={open} className="flex h-full min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronRight className={cx("size-3.5 flex-none text-fg-3 transition-transform", open && "rotate-90")} />
          <span className="w-5 flex-none font-mono text-xs text-fg-3 tabular-nums">{n}</span>
          <MethodBadge method={step.method} />
          <span className="flex-none text-base font-medium">{step.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{step.url}</span>
          {issue && (
            <span title={issue.message} className="flex-none">
              <TriangleAlert className={cx("size-3.5", issue.level === "error" ? "text-bad-soft" : "text-warm")} aria-label={issue.message} />
            </span>
          )}
          {step.body.kind === "file" && outsideWorkspace(step.body.file) && (
            <span className="flex-none rounded bg-warm/15 px-1.5 text-xs text-warm" title={`${step.body.file} is outside the workspace, so it won't be sent`}>
              file outside workspace
            </span>
          )}
          {step.poll && <span className="flex-none rounded bg-surface-3 px-1.5 text-xs text-fg-2">poll</span>}
          {step.retry && (
            <span className="flex-none rounded bg-surface-3 px-1.5 text-xs text-fg-2" title={`Re-sent up to ${step.retry.max} more times ${step.retry.on === "any" ? "if it fails" : "on errors and 5xx"}`}>
              retry ×{step.retry.max}
            </span>
          )}
          {step.onFailure === "continue" && (
            <span className="flex-none rounded bg-surface-3 px-1.5 text-xs text-fg-2" title="The flow keeps going if this request fails">
              keeps going
            </span>
          )}
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
          {out?.retrying && out.state === "sending" && (
            <span className="flex-none font-mono text-xs text-warm">
              retry {out.retrying.attempt}/{out.retrying.of}
            </span>
          )}
          {out?.state === "skipped" && <span className="flex-none text-xs text-fg-3">{notTaken ? "not taken" : "skipped"}</span>}
          {out?.state === "error" && <span className="flex-none text-xs text-bad-soft">not sent</span>}
          {(out?.attempts ?? 1) > 1 && out?.state !== "sending" && <span className="flex-none font-mono text-xs text-fg-3">{out!.attempts} attempts</span>}
          {r && <span className={cx("flex-none font-mono text-xs font-semibold", r.status < 400 ? "text-ok" : "text-bad")}>{r.status}</span>}
          {r && <span className="w-14 flex-none text-right font-mono text-xs text-fg-3">{formatMs(r.totalMs)}</span>}
          {mark && <StatusMark status={mark} size={10} className={STATUS_TEXT[mark]} />}
        </button>
      </div>
      {open && children}
    </div>
  );
}

/* ---------------- blocks ---------------- */

/**
 * An if or parallel block: a header row, then its lanes of requests, each
 * hung from a 1px rail so it reads as part of the block.
 */
function BlockView({
  path,
  block,
  taken,
  issues,
  onRemove,
  onAdd,
  onDropLane,
  stepRow,
  ...drag
}: DragProps & {
  path: string;
  block: FlowBlock;
  /** The lane the last run took (if blocks). */
  taken?: "then" | "else";
  issues: Issue[];
  onRemove: () => void;
  onAdd: (lane: Lane) => void;
  onDropLane: (lane: Lane) => void;
  stepRow: (st: FlowStep, notTaken?: boolean) => ReactNode;
}) {
  const [editing, setEditing] = useState(block.type === "if" && !block.when.some((c) => c.left.trim()));
  const isIf = block.type === "if";
  const issue = issues.find((i) => i.level === "error") ?? issues[0];
  const conditions = isIf ? block.when.filter((c) => c.left.trim()) : [];
  const summary = conditions.map((c) => (c.op === "exists" || c.op === "!exists" ? `${c.left} ${c.op}` : `${c.left} ${c.op} ${c.right}`)).join("  and  ");

  const lane = (key: "then" | "else" | "steps", steps: FlowStep[], label?: string, hint?: string) => {
    const where: Lane = { block: block.id, lane: key };
    const notTaken = !!taken && key !== "steps" && key !== taken;
    return (
      <div key={key}>
        {label && (
          <div className="flex h-8 items-center gap-2 border-b border-line bg-surface pl-10 text-xs">
            <span className={cx("font-semibold tracking-wider uppercase", notTaken ? "text-fg-3" : "text-fg-2")}>{label}</span>
            <span className="text-fg-3">{hint}</span>
            {taken === key && (
              <span className="flex items-center gap-1 text-ok">
                <StatusMark status="running" size={8} /> taken
              </span>
            )}
          </div>
        )}
        {/* The lane's rail: requests in it are indented and hang from a 1px hairline. */}
        <div className="relative bg-surface pl-6 before:absolute before:inset-y-0 before:left-[14px] before:w-px before:bg-line-strong">
          {steps.map((st) => stepRow(st, notTaken))}
          <button
            className="flex h-8 w-full items-center gap-1.5 border-b border-line bg-surface pl-10 text-sm text-fg-3 hover:bg-surface-2 hover:text-fg-2 disabled:pointer-events-none"
            onClick={() => onAdd(where)}
            onDragEnter={() => drag.dragId && onDropLane(where)}
            onDragOver={(e) => e.preventDefault()}
            disabled={drag.locked}
          >
            <Plus className="size-3.5" /> {steps.length ? "Add request" : key === "steps" ? "Add a request to send at the same time" : "Add a request, or drag one here"}
          </button>
        </div>
      </div>
    );
  };

  return (
    <section
      aria-label={isIf ? "If block" : "Parallel block"}
      className={cx("border-b border-line last:border-b-0", drag.dragId === block.id && "opacity-50")}
      onDragEnter={(e) => e.target === e.currentTarget && drag.dragTo(block.id)}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="group flex h-11 items-center gap-3 bg-rail pr-2 pl-1" onDragEnter={() => drag.dragTo(block.id)}>
        <Grip id={block.id} locked={drag.locked} onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd} />
        <button
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
          onClick={() => isIf && setEditing((v) => !v)}
          disabled={!isIf}
          aria-expanded={isIf ? editing : undefined}
        >
          {isIf ? <ChevronRight className={cx("size-3.5 flex-none text-fg-3 transition-transform", editing && "rotate-90")} /> : <span className="w-3.5 flex-none" />}
          {isIf ? <Split className="size-4 flex-none rotate-90 text-fg-2" aria-hidden /> : <Rows3 className="size-4 flex-none text-fg-2" aria-hidden />}
          <span className="flex-none text-xs font-semibold tracking-wider text-fg uppercase">{isIf ? "If" : "Parallel"}</span>
          {isIf ? (
            summary ? (
              <span className="min-w-0 truncate font-mono text-xs text-fg-2">{summary}</span>
            ) : (
              <span className="text-sm text-fg-3">no condition yet</span>
            )
          ) : (
            <span className="min-w-0 truncate text-sm text-fg-3">
              {block.steps.length ? `${block.steps.length} request${block.steps.length === 1 ? "" : "s"} sent at the same time` : "requests here are sent at the same time"}
            </span>
          )}
          {isIf && <span className="flex-none text-xs text-fg-3">on the previous response</span>}
        </button>
        {issue && (
          <span title={issue.message} className="flex-none">
            <TriangleAlert className={cx("size-3.5", issue.level === "error" ? "text-bad-soft" : "text-warm")} aria-label={issue.message} />
          </span>
        )}
        <IconButton label={isIf ? "Delete if block and its requests" : "Delete parallel block and its requests"} onClick={onRemove} disabled={drag.locked}>
          <Trash2 />
        </IconButton>
      </div>
      {isIf && editing && (
        <div className="border-b border-line bg-bg px-10 py-3">
          <ChecksEditor
            checks={block.when}
            onChange={(when) => updateFlow(path, (f) => ({ ...f, steps: f.steps.map((i) => (i.id === block.id && i.type === "if" ? { ...i, when } : i)) }))}
            note="Then runs when every condition holds on the response of the request above; otherwise Else runs."
            empty="Add a condition on the previous response, like status == 404."
          />
        </div>
      )}
      {isIf ? [lane("then", block.then, "Then", "when it matches"), lane("else", block.else, "Else", "otherwise")] : lane("steps", block.steps)}
    </section>
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
  const addBlock = (type: FlowBlock["type"]) => updateFlow(doc.path, (f) => ({ ...f, steps: [...f.steps, blankBlock(type)] }));

  const addFromCurl = async () => {
    if (!plan) return;
    if (Object.keys(plan.newSecrets).length) {
      const env = envs[envName] ?? { name: envName, vars: {}, baseUrls: {}, insecureTls: false, network: DEFAULT_NETWORK, secrets: {} };
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
      ...blankStep(allSteps(doc.steps).length + 1, plan.url),
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
        <Button onClick={() => add(blankStep(allSteps(doc.steps).length + 1, ""))}>
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
        <span className="mx-1 w-px self-stretch bg-line" aria-hidden />
        <Button variant="ghost" onClick={() => addBlock("if")} title="Run one of two lanes of requests, depending on the previous response">
          <Split className="rotate-90" /> If block
        </Button>
        <Button variant="ghost" onClick={() => addBlock("parallel")} title="Send several requests at the same time">
          <Rows3 /> Parallel block
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
