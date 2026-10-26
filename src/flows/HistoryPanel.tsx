/**
 * Past runs of a flow (`.auxin/runs/<flow>/`), each compared with the run
 * before it. A run can be replayed: the flow as it was then, with today's
 * environment. Each request keeps its (redacted) request and response.
 */
import { ChevronRight, RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusMark, STATUS_TEXT, type Shown } from "../components/status";
import { Button, cx, IconButton } from "../components/ui";
import { formatMs, MethodBadge } from "./parts";
import { isRunning, loadHistory, replayRun, type RunRecord } from "./runner";
import { HeaderList } from "./StepDetail";
import { useFlows } from "./store";
import { TrendList } from "./TrendList";
import { flowTrends } from "./trends";

const TONE: Record<RunRecord["status"], Shown> = { passed: "running", failed: "crashed", cancelled: "stopped", running: "starting" };
const STEP_TONE: Record<string, Shown> = {
  passed: "running",
  failed: "crashed",
  error: "crashed",
  skipped: "stopped",
  cancelled: "stopped",
  queued: "queued",
  sending: "starting",
  polling: "starting",
};

export function HistoryPanel({ path, onClose }: { path: string; onClose: () => void }) {
  const run = useFlows((s) => s.runs[path]);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const running = run?.status === "running" || isRunning(path);
  const [showTrends, setShowTrends] = useState(true);
  const trends = useMemo(() => flowTrends(runs ?? []), [runs]);

  const load = () => void loadHistory(path).then(setRuns);
  // Reload once a finished run's history file is written.
  useEffect(load, [path, run?.historySavedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="flex w-[380px] flex-none flex-col border-l border-line bg-surface" aria-label="Run history">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-line pr-2 pl-4">
        <span className="font-semibold">Run history</span>
        <span className="text-xs text-fg-3">last 30</span>
        <span className="flex-1" />
        <IconButton label="Reload" onClick={load}>
          <RefreshCw />
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs == null && <p className="p-4 text-sm text-fg-3">Loading…</p>}
        {runs?.length === 0 && <p className="p-4 text-sm text-fg-3">No runs yet. Press Run flow; every run is kept in .auxin/runs (ignored by git).</p>}
        {runs && runs.length >= 2 && (
          <section className="border-b border-line pb-1" aria-label="Trends">
            <button
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-2"
              onClick={() => setShowTrends((v) => !v)}
              aria-expanded={showTrends}
            >
              <ChevronRight className={cx("size-3.5 flex-none text-fg-3 transition-transform", showTrends && "rotate-90")} />
              <span className="text-sm font-semibold">Trends</span>
              <span className="text-xs text-fg-3">response times over the last {runs.length} runs, oldest first</span>
            </button>
            {showTrends && <TrendList trends={trends} />}
          </section>
        )}
        {runs?.map((r, i) => {
          const prev = runs[i + 1];
          const total = r.steps.reduce((a, s) => a + (s.ms ?? 0), 0);
          const prevTotal = prev?.steps.reduce((a, s) => a + (s.ms ?? 0), 0);
          const isOpen = open === r.runId;
          return (
            <div key={r.runId} className="border-b border-line">
              <button
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2"
                onClick={() => setOpen(isOpen ? null : r.runId)}
                aria-expanded={isOpen}
              >
                <ChevronRight className={cx("size-3.5 flex-none text-fg-3 transition-transform", isOpen && "rotate-90")} />
                <StatusMark status={TONE[r.status]} size={9} className={STATUS_TEXT[TONE[r.status]]} />
                <span className="grid min-w-0 flex-1">
                  <span className="text-sm text-fg">
                    {new Date(r.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className="text-xs text-fg-3">
                    {r.status} · env {r.env}
                    {r.replayOf && " · replay"}
                  </span>
                </span>
                <span className="text-right font-mono text-xs text-fg-2">
                  {formatMs(total)}
                  {prevTotal != null && <Delta now={total} before={prevTotal} />}
                </span>
              </button>
              {isOpen && (
                <div className="grid gap-1 px-4 pb-3">
                  <div className="flex items-center gap-2 pb-1">
                    <Button
                      size="sm"
                      disabled={!r.snapshot || running}
                      onClick={() => void replayRun(path, r)}
                      title={
                        r.snapshot
                          ? "Run the flow as it was in this run, with the current environment"
                          : "Recorded before replay existed: this run didn't save its flow"
                      }
                    >
                      <RotateCcw /> Replay
                    </Button>
                    <span className="text-xs text-fg-3">
                      {r.snapshot ? "Same requests as this run, current environment." : "Can't replay a run recorded before replay existed."}
                    </span>
                  </div>
                  {r.steps.map((s) => {
                    const p = prev?.steps.find((x) => x.id === s.id);
                    const changed = p && p.state !== s.state;
                    const notTaken = s.state === "skipped" && Object.values(r.branches ?? {}).length > 0 && laneNotTaken(r, s.id);
                    return (
                      <div key={s.id} className="grid gap-0.5 rounded-md bg-bg px-2.5 py-1.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <StatusMark status={STEP_TONE[s.state] ?? "stopped"} size={8} className={STATUS_TEXT[STEP_TONE[s.state] ?? "stopped"]} />
                          <MethodBadge method={s.method} />
                          <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
                          {s.status != null && <span className={cx("font-mono text-xs", s.status < 400 ? "text-ok" : "text-bad")}>{s.status}</span>}
                          {s.ms != null && (
                            <span className="font-mono text-xs text-fg-3">
                              {formatMs(s.ms)}
                              {p?.ms != null && <Delta now={s.ms} before={p.ms} />}
                            </span>
                          )}
                        </div>
                        {changed && (
                          <span className="pl-4 text-xs text-warm">
                            was {p!.state}, now {s.state}
                          </span>
                        )}
                        {s.error && <span className="truncate pl-4 text-xs text-bad-soft">{s.error}</span>}
                        {s.checks
                          .filter((c) => !c.ok)
                          .map((c) => (
                            <span key={c.label} className="truncate pl-4 font-mono text-xs text-bad-soft">
                              ✕ {c.label} · got {c.got}
                            </span>
                          ))}
                        {s.hops.length > 0 && (
                          <span className="truncate pl-4 font-mono text-xs text-fg-3">{s.hops.map((h) => `${h.alias}${h.ok ? "" : " ⚠"}`).join(" → ")}</span>
                        )}
                        {notTaken && <span className="pl-4 text-xs text-fg-3">not taken by the if block</span>}
                        {(s.request || s.response) && <Exchange step={s} />}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** Whether a request sat in an if lane this run didn't take (from the run's own flow). */
function laneNotTaken(r: RunRecord, stepId: string): boolean {
  const blocks = ((r.snapshot as { steps?: { id: string; type: string; then?: { id: string }[]; else?: { id: string }[] }[] })?.steps ?? []).filter(
    (b) => b.type === "if",
  );
  const b = blocks.find((x) => [...(x.then ?? []), ...(x.else ?? [])].some((s) => s.id === stepId));
  const taken = b && r.branches?.[b.id];
  return !!taken && !(b[taken] ?? []).some((s) => s.id === stepId);
}

/** The recorded request and response of one request in a past run, folded away until asked for. */
function Exchange({ step }: { step: RunRecord["steps"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pl-4">
      <button className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight className={cx("size-3 transition-transform", open && "rotate-90")} /> Request and response
      </button>
      {open && (
        <div className="mt-1 grid gap-2 border-l border-line-strong pl-2.5">
          {step.request && (
            <div className="grid gap-1">
              <span className="font-mono text-xs break-all text-fg select-text">
                {step.method} {step.url}
              </span>
              <HeaderList rows={step.request.headers} bare narrow />
              {step.request.body && (
                <pre className="max-h-40 overflow-auto rounded bg-rail p-2 font-mono text-xs break-all whitespace-pre-wrap text-fg-2 select-text">
                  {step.request.body}
                </pre>
              )}
            </div>
          )}
          {step.response && (
            <div className="grid gap-1">
              <span className={cx("font-mono text-xs font-semibold", step.response.status < 400 ? "text-ok" : "text-bad")}>{step.response.status}</span>
              <HeaderList rows={step.response.headers} bare narrow />
              {step.response.body && (
                <pre className="max-h-56 overflow-auto rounded bg-rail p-2 font-mono text-xs break-all whitespace-pre-wrap text-fg-2 select-text">
                  {step.response.body}
                  {step.response.truncated && "\n… cut at 64 KB"}
                </pre>
              )}
            </div>
          )}
          <span className="text-xs text-fg-3">Secrets and token-like fields are hidden in saved runs.</span>
        </div>
      )}
    </div>
  );
}

/** "+120ms" / "−40ms" against the previous run, hidden when the change is noise. */
function Delta({ now, before }: { now: number; before: number }) {
  const d = now - before;
  if (Math.abs(d) < Math.max(5, before * 0.1)) return null;
  return <span className={cx("ml-1", d > 0 ? "text-warm" : "text-ok")}>{d > 0 ? `+${formatMs(d)}` : `−${formatMs(-d)}`}</span>;
}
