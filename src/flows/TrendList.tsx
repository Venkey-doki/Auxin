/**
 * Per-request trends across saved runs: a sparkline of response times (oldest
 * on the left), the median and 95th percentile, and how many runs failed. One
 * series per row, so no legend; failures are red dots and also counted in text.
 */
import { useState } from "react";
import { cx } from "../components/ui";
import { formatMs } from "./parts";
import type { Trend, TrendPoint } from "./trends";

const W = 88;
const H = 22;
const PAD = 3;

export function TrendList({ trends }: { trends: Trend[] }) {
  return (
    <table className="w-full border-collapse text-sm" aria-label="Request trends">
      <thead>
        <tr className="text-[11px] tracking-wider text-fg-3 uppercase">
          <th className="py-1 pl-4 text-left font-semibold">Request</th>
          <th className="py-1 font-semibold">
            <span className="sr-only">Response time per run, oldest first</span>
          </th>
          <th className="py-1 pl-2 text-right font-semibold">p50</th>
          <th className="py-1 pl-2 text-right font-semibold">p95</th>
          <th className="py-1 pr-4 pl-2 text-right font-semibold">failed</th>
        </tr>
      </thead>
      <tbody>
        {trends.map((t) => (
          <tr key={t.id || "whole"} className={cx("border-t border-line", !t.id && "font-medium")}>
            <td className="max-w-0 py-1.5 pl-4">
              <span className="block truncate" title={t.method ? `${t.method} ${t.name}` : t.name}>
                {t.name}
              </span>
            </td>
            <td className="w-[96px] px-1 py-1.5">
              <Sparkline points={t.points} label={t.name} />
            </td>
            <td className="w-14 py-1.5 pl-2 text-right font-mono text-xs text-fg-2 tabular-nums">{t.p50 != null ? formatMs(t.p50) : "–"}</td>
            <td className="w-14 py-1.5 pl-2 text-right font-mono text-xs text-fg-2 tabular-nums">{t.p95 != null ? formatMs(t.p95) : "–"}</td>
            <td className={cx("w-14 py-1.5 pr-4 pl-2 text-right font-mono text-xs tabular-nums", t.failures ? "text-bad-soft" : "text-fg-3")}>
              {t.failures}/{t.runs}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Response time per run on a zero-based scale; gaps where a run didn't send the request. */
function Sparkline({ points, label }: { points: TrendPoint[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.flatMap((p) => (p.ms != null ? [p.ms] : [])));
  const x = (i: number) => (points.length < 2 ? W / 2 : PAD + (i / (points.length - 1)) * (W - PAD * 2));
  const y = (ms: number) => H - PAD - (ms / max) * (H - PAD * 2);
  // Consecutive runs with a time form one segment; a run without one breaks the line.
  const segments: string[] = [];
  let d = "";
  points.forEach((p, i) => {
    if (p.ms == null) {
      if (d) segments.push(d);
      d = "";
    } else d += `${d ? "L" : "M"}${x(i).toFixed(1)} ${y(p.ms).toFixed(1)}`;
  });
  if (d) segments.push(d);
  const last = points.length - 1;
  const shown = hover != null ? points[hover] : undefined;

  return (
    <span className="relative block" onPointerLeave={() => setHover(null)}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block overflow-visible"
        role="img"
        aria-label={`${label}: response time over the last ${points.length} runs`}
      >
        <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} stroke="var(--color-line)" strokeWidth={1} />
        {segments.map((s, i) => (
          <path key={i} d={s} fill="none" stroke="var(--color-fg-3)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {points.map((p, i) =>
          p.failed || (i === last && p.ms != null) ? (
            <circle
              key={p.runId}
              cx={x(i)}
              cy={p.ms != null ? y(p.ms) : H - PAD}
              r={3}
              fill={p.failed ? "var(--color-bad)" : "var(--color-paper)"}
              stroke="var(--color-surface)"
              strokeWidth={1.5}
            />
          ) : null,
        )}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--color-fg-3)" strokeWidth={1} opacity={0.5} />}
        {/* Hit targets wider than the marks: one column per run. */}
        {points.map((p, i) => (
          <rect
            key={`hit-${p.runId}`}
            x={x(i) - W / Math.max(2, points.length) / 2}
            y={0}
            width={W / Math.max(2, points.length)}
            height={H}
            fill="transparent"
            onPointerEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {shown && (
        <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 rounded-md border border-line-strong bg-pop px-2 py-1 text-xs whitespace-nowrap text-fg shadow-[0_12px_32px_rgb(0_0_0/0.5)]">
          <span className="font-mono font-semibold">{shown.ms != null ? formatMs(shown.ms) : "no response"}</span>
          <span className="text-fg-3">
            {" "}
            · {new Date(shown.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
          {shown.failed && <span className="text-bad-soft"> · failed</span>}
          {shown.ms == null && !shown.failed && <span className="text-fg-3"> · not sent</span>}
        </span>
      )}
    </span>
  );
}
