import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GroupLayout } from "../lib/types";
import { SERVICE_COLORS } from "../lib/util";
import { selectServices, useStore } from "../state/store";
import { LogView } from "./LogView";
import { shownStatus, STATUS_TEXT, StatusMark, useNow } from "./status";
import { Ticket } from "./Ticket";
import { cx } from "./ui";

/** The rail: tickets in a row, each with its log column hanging beneath. */
export function Board({
  ids,
  layout,
  onRemove,
  empty,
}: {
  ids: string[];
  layout: GroupLayout;
  onRemove?: (id: string) => void;
  empty?: ReactNode;
}) {
  const all = useStore(selectServices);
  const services = useMemo(() => ids.map((id) => all.find((s) => s.id === id)).filter((s) => !!s), [ids, all]);
  const [focus, setFocus] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focused = focus && services.some((s) => s.id === focus) ? focus : null;

  if (!services.length) return <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-8">{empty}</div>;

  if (layout === "merged") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <MergedLegend ids={services.map((s) => s.id)} />
        <div className="min-h-0 flex-1">
          <LogView ids={services.map((s) => s.id)} tagged empty="Start a service to see its output here." />
        </div>
      </div>
    );
  }

  const shown = focused ? services.filter((s) => s.id === focused) : services;
  const grid = layout === "grid" && shown.length > 1;
  const rows = grid ? Math.ceil(shown.length / 2) : 1;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RailIndex ids={shown.map((s) => s.id)} scroller={scrollRef} />
      <div ref={scrollRef} className={cx("min-h-0 flex-1", grid ? "overflow-y-auto" : "overflow-x-auto")}>
        <div
          className={cx("h-full gap-px bg-line", grid ? "grid grid-cols-2" : "flex")}
          style={grid ? { gridTemplateRows: `repeat(${rows}, minmax(320px, 1fr))`, height: rows > 2 ? `${rows * 50}%` : "100%" } : undefined}
        >
          {shown.map((s) => (
            <section key={s.id} data-lane={s.id} aria-label={s.name} className={cx("flex min-h-0 flex-col bg-rail", !grid && "min-w-[320px] flex-1")}>
              <div className="rail-bar flex-none" aria-hidden />
              <Ticket
                service={s}
                onRemove={onRemove ? () => onRemove(s.id) : undefined}
                onFocus={services.length > 1 ? () => setFocus(focused ? null : s.id) : undefined}
                focused={!!focused}
              />
              <div className="min-h-0 flex-1">
                <LogView ids={[s.id]} compact empty={<LaneEmpty id={s.id} />} />
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * When the rail is wider than the window, a strip of every ticket's state sits
 * above it, so a crash in an off-screen lane is still seen; click to bring it in.
 */
function RailIndex({ ids, scroller }: { ids: string[]; scroller: React.RefObject<HTMLDivElement | null> }) {
  const all = useStore(selectServices);
  const runtime = useStore((s) => s.runtime);
  const now = useNow(1000);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller, ids.length]);

  if (!overflow) return null;
  return (
    <div className="flex flex-none items-center gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-1.5" aria-label="All tickets on this rail">
      {ids.map((id) => {
        const s = all.find((x) => x.id === id);
        if (!s) return null;
        const st = shownStatus(runtime[id], now);
        return (
          <button
            key={id}
            onClick={() => scroller.current?.querySelector(`[data-lane="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" })}
            className={cx(
              "flex h-6 flex-none items-center gap-1.5 rounded px-2 text-sm whitespace-nowrap transition-colors hover:bg-surface-3",
              st === "crashed" ? "bg-bad/10 text-bad-soft" : "text-fg-2",
            )}
          >
            <StatusMark status={st} size={8} className={STATUS_TEXT[st]} />
            {s.name}
          </button>
        );
      })}
    </div>
  );
}

function LaneEmpty({ id }: { id: string }) {
  const rt = useStore((s) => s.runtime[id]);
  return <>{rt ? "Waiting for output…" : "Not started yet."}</>;
}

/** In a merged stream the tags carry identity; the legend maps them back to state. */
function MergedLegend({ ids }: { ids: string[] }) {
  const all = useStore(selectServices);
  const runtime = useStore((s) => s.runtime);
  const now = useNow(1000);
  return (
    <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-surface px-5 py-2.5">
      {ids.map((id) => {
        const s = all.find((x) => x.id === id);
        if (!s) return null;
        const st = shownStatus(runtime[id], now);
        return (
          <span className="flex items-center gap-1.5 text-sm text-fg-2" key={id}>
            <StatusMark status={st} size={8} className={STATUS_TEXT[st]} />
            <span className="h-2.5 w-[3px] rounded-full" style={{ background: SERVICE_COLORS[s.color] }} aria-hidden />
            {s.name}
          </span>
        );
      })}
    </div>
  );
}
