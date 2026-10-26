/** Past runs of a flow (`.auxin/runs/<flow>/`), each compared with the run before it. */
import { ChevronRight, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusMark, STATUS_TEXT, type Shown } from "../components/status";
import { cx, IconButton } from "../components/ui";
import { formatMs, MethodBadge } from "./parts";
import { loadHistory, type RunRecord } from "./runner";
import { useFlows } from "./store";

const TONE: Record<RunRecord["status"], Shown> = { passed: "running", failed: "crashed", cancelled: "stopped", running: "starting" };
const STEP_TONE: Record<string, Shown> = { passed: "running", failed: "crashed", error: "crashed", skipped: "stopped", cancelled: "stopped", queued: "queued", sending: "starting", polling: "starting" };

export function HistoryPanel({ path, onClose }: { path: string; onClose: () => void }) {
  const run = useFlows((s) => s.runs[path]);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => void loadHistory(path).then(setRuns);
  // Reload once a finished run's history file is written.
  useEffect(load, [path, run?.historySavedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="flex w-[380px] flex-none flex-col border-l border-line bg-surface" aria-label="Run history">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-line pr-2 pl-4">
        <span className="font-semibold">Run history</span>
        <span className="text-xs text-fg-3">last 20</span>
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
        {runs?.map((r, i) => {
          const prev = runs[i + 1];
          const total = r.steps.reduce((a, s) => a + (s.ms ?? 0), 0);
          const prevTotal = prev?.steps.reduce((a, s) => a + (s.ms ?? 0), 0);
          const isOpen = open === r.runId;
          return (
            <div key={r.runId} className="border-b border-line">
              <button className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2" onClick={() => setOpen(isOpen ? null : r.runId)} aria-expanded={isOpen}>
                <ChevronRight className={cx("size-3.5 flex-none text-fg-3 transition-transform", isOpen && "rotate-90")} />
                <StatusMark status={TONE[r.status]} size={9} className={STATUS_TEXT[TONE[r.status]]} />
                <span className="grid min-w-0 flex-1">
                  <span className="text-sm text-fg">{new Date(r.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span className="text-xs text-fg-3">
                    {r.status} · env {r.env}
                  </span>
                </span>
                <span className="text-right font-mono text-xs text-fg-2">
                  {formatMs(total)}
                  {prevTotal != null && <Delta now={total} before={prevTotal} />}
                </span>
              </button>
              {isOpen && (
                <div className="grid gap-1 px-4 pb-3">
                  {r.steps.map((s) => {
                    const p = prev?.steps.find((x) => x.id === s.id);
                    const changed = p && p.state !== s.state;
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
                        {s.hops.length > 0 && <span className="truncate pl-4 font-mono text-xs text-fg-3">{s.hops.map((h) => `${h.alias}${h.ok ? "" : " ⚠"}`).join(" → ")}</span>}
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

/** "+120ms" / "−40ms" against the previous run, hidden when the change is noise. */
function Delta({ now, before }: { now: number; before: number }) {
  const d = now - before;
  if (Math.abs(d) < Math.max(5, before * 0.1)) return null;
  return <span className={cx("ml-1", d > 0 ? "text-warm" : "text-ok")}>{d > 0 ? `+${formatMs(d)}` : `−${formatMs(-d)}`}</span>;
}
