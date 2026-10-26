/**
 * A step's OpenTelemetry spans as a waterfall: one row per span, nested under
 * its parent, with a bar on a shared time axis. Traces reached through a link
 * (a queue consumer's) follow under their own label.
 */
import { Link2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "../components/ui";
import type { Span } from "../lib/api";
import { SERVICE_COLORS } from "../lib/util";
import { selectServices, serviceForSpan, useStore } from "../state/store";
import { formatMs } from "./parts";
import { spanRows, spanSummary } from "./spans";

const KIND_SHORT: Record<Span["kind"], string> = { unspecified: "", internal: "", server: "server", client: "client", producer: "publish", consumer: "consume" };

export function SpanWaterfall({ spans, traceId }: { spans: Span[]; traceId?: string }) {
  const services = useStore(selectServices);
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => spanRows(spans, traceId ? [traceId] : []), [spans, traceId]);
  const t0 = Math.min(...spans.map((s) => s.startMs));
  const t1 = Math.max(...spans.map((s) => s.startMs + s.durationMs));
  const total = Math.max(1, t1 - t0);
  const colorOf = (name: string) => SERVICE_COLORS[serviceForSpan(services, name)?.color ?? 9];

  return (
    <div className="border-b border-line py-1.5" aria-label="OpenTelemetry spans">
      {rows.map(({ span: s, depth, linked }, i) => {
        const firstLinked = linked && !rows[i - 1]?.linked;
        const bad = s.status === "error";
        const summary = spanSummary(s);
        const isOpen = open === s.spanId;
        return (
          <div key={`${s.traceId}${s.spanId}`}>
            {firstLinked && (
              <div className="mx-4 mt-1.5 mb-1 flex items-center gap-1.5 border-t border-line pt-2 text-xs text-fg-3">
                <Link2 className="size-3" aria-hidden /> Linked trace: work that started from a message this request sent
              </div>
            )}
            <button
              className={cx("grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_64px] items-center gap-3 px-4 py-0.5 text-left text-sm hover:bg-surface-2", isOpen && "bg-surface-2")}
              onClick={() => setOpen(isOpen ? null : s.spanId)}
              aria-expanded={isOpen}
              title={s.statusMessage ?? undefined}
            >
              <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 14 }}>
                <span className="h-3 w-[3px] flex-none rounded-full" style={{ background: colorOf(s.service) }} aria-hidden />
                <span className={cx("truncate", bad ? "text-bad-soft" : "text-fg")}>{s.name}</span>
                {KIND_SHORT[s.kind] && <span className="flex-none font-mono text-2xs text-fg-3">{KIND_SHORT[s.kind]}</span>}
              </span>
              <span className="relative h-2 rounded-full bg-surface-3" aria-hidden>
                <span
                  className="absolute inset-y-0 rounded-full"
                  style={{ left: `${((s.startMs - t0) / total) * 100}%`, width: `${Math.max(1, (s.durationMs / total) * 100)}%`, background: bad ? "var(--color-bad)" : colorOf(s.service) }}
                />
              </span>
              <span className={cx("text-right font-mono text-xs", bad ? "text-bad-soft" : "text-fg-3")}>{formatMs(Math.round(s.durationMs))}</span>
            </button>
            {isOpen && (
              <div className="mx-4 mb-1.5 grid gap-1 rounded-md bg-rail px-3 py-2 font-mono text-xs" style={{ marginLeft: 16 + depth * 14 }}>
                <span className="text-fg-2">
                  {s.service}
                  {summary && ` · ${summary}`}
                  {s.statusMessage && <span className="text-bad-soft"> · {s.statusMessage}</span>}
                </span>
                {s.attributes.map(([k, v]) => (
                  <span key={k} className="flex gap-3">
                    <span className="w-48 flex-none truncate text-fg-3">{k}</span>
                    <span className="min-w-0 break-all text-fg select-text">{v}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
