import { useEffect, useState } from "react";
import type { Runtime } from "../lib/types";

export type Shown = "running" | "starting" | "stopping" | "stopped" | "exited" | "crashed" | "waiting" | "queued";

/** A freshly spawned process reads as "starting" until it announces a port or settles. */
export function shownStatus(r: Runtime | undefined, now: number): Shown {
  if (!r) return "stopped";
  if (r.status === "running" && !r.port && r.startedAt && now - r.startedAt < 2500) return "starting";
  return r.status;
}

export const STATUS_LABEL: Record<Shown, string> = {
  running: "Running",
  starting: "Starting",
  stopping: "Stopping",
  stopped: "Stopped",
  exited: "Exited",
  crashed: "Crashed",
  waiting: "Waiting",
  queued: "Queued",
};

/** State hue on the steel shell. */
export const STATUS_TEXT: Record<Shown, string> = {
  running: "text-ok",
  starting: "text-warm",
  waiting: "text-warm",
  stopping: "text-warm",
  crashed: "text-bad",
  stopped: "text-idle",
  exited: "text-idle",
  queued: "text-fg-3",
};

/** The darker twin, for stamps printed on paper. */
export const STATUS_INK: Record<Shown, string> = {
  running: "text-ok-ink",
  starting: "text-warm-ink",
  waiting: "text-warm-ink",
  stopping: "text-warm-ink",
  crashed: "text-bad-ink",
  stopped: "text-idle-ink",
  exited: "text-idle-ink",
  queued: "text-idle-ink",
};

/** Status carried by shape as well as hue: solid, dashed ring, struck ring, hollow. */
export function StatusMark({ status, size = 10, className }: { status: Shown; size?: number; className?: string }) {
  const r = size / 2 - 1;
  const c = size / 2;
  const common = {
    width: size,
    height: size,
    viewBox: `0 0 ${size} ${size}`,
    "aria-hidden": true,
    className: `flex-none ${className ?? ""}${status === "starting" || status === "waiting" ? " animate-spin-slow" : ""}`,
  } as const;
  switch (status) {
    case "running":
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r} fill="currentColor" />
        </svg>
      );
    case "starting":
    case "waiting":
    case "stopping":
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r - 0.5} fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.4 1.8" />
        </svg>
      );
    case "crashed":
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r - 0.5} fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d={`M${c - r * 0.7} ${c + r * 0.7}L${c + r * 0.7} ${c - r * 0.7}`} stroke="currentColor" strokeWidth="1.6" />
        </svg>
      );
    case "queued":
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r - 0.5} fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="1 1.6" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r - 0.5} fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
  }
}

/** Re-renders every `ms` so uptimes and the starting window stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
