/**
 * How a flow's requests have been doing across its saved runs: each request's
 * time per run (oldest to newest), its median and 95th percentile, and how
 * often it failed. Built from run records, so nothing extra is stored.
 */
import type { RunRecord } from "./runner";

export interface TrendPoint {
  runId: string;
  at: string;
  /** Response time; missing when the request didn't get a response (or didn't run). */
  ms?: number;
  /** It was sent this run (a queue step that passed may still have no time). */
  ran: boolean;
  failed: boolean;
}

export interface Trend {
  /** Step id, or "" for the whole run. */
  id: string;
  name: string;
  method?: string;
  points: TrendPoint[];
  p50?: number;
  p95?: number;
  /** Runs where it was sent, and how many of those failed. */
  runs: number;
  failures: number;
}

/** Nearest-rank percentile of `values` (0–100). */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function summarise(t: Omit<Trend, "p50" | "p95" | "runs" | "failures">): Trend {
  const sent = t.points.filter((p) => p.ran);
  const times = t.points.flatMap((p) => (p.ms != null ? [p.ms] : []));
  return { ...t, p50: percentile(times, 50), p95: percentile(times, 95), runs: sent.length, failures: sent.filter((p) => p.failed).length };
}

const FAILED = new Set(["failed", "error"]);

/**
 * One trend for the whole run, then one per request in the newest run's order
 * (requests that only old runs had come after). `records` is newest first, as
 * `loadHistory` returns them.
 */
export function flowTrends(records: RunRecord[]): Trend[] {
  const runs = [...records].reverse();
  if (!runs.length) return [];
  const whole = summarise({
    id: "",
    name: "Whole run",
    // A stopped run's time says when you pressed Stop, not how long the flow takes.
    points: runs.map((r) =>
      r.status === "cancelled"
        ? { runId: r.runId, at: r.startedAt, ran: false, failed: false }
        : { runId: r.runId, at: r.startedAt, ms: Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt)), ran: true, failed: r.status === "failed" },
    ),
  });
  const order: { id: string; name: string; method: string }[] = [];
  for (const r of [...records]) for (const s of r.steps) if (!order.some((o) => o.id === s.id)) order.push({ id: s.id, name: s.name, method: s.method });
  const steps = order.map((o) =>
    summarise({
      ...o,
      points: runs.map((r): TrendPoint => {
        const s = r.steps.find((x) => x.id === o.id);
        if (!s || s.state === "skipped" || s.state === "cancelled" || s.state === "queued")
          return { runId: r.runId, at: r.startedAt, ran: false, failed: false };
        return { runId: r.runId, at: r.startedAt, ms: s.ms, ran: true, failed: FAILED.has(s.state) };
      }),
    }),
  );
  return [whole, ...steps];
}
