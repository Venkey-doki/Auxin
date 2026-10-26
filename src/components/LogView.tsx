import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Clock, CornerDownLeft, Search, Trash2, TriangleAlert, WrapText, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseAnsi } from "../lib/ansi";
import { api } from "../lib/api";
import { formatClock, SERVICE_COLORS } from "../lib/util";
import { clearLogs, getMerged, useLogTick, type LogEntry } from "../state/logs";
import { selectServices, toast, useStore } from "../state/store";
import { cx, IconButton } from "./ui";

const ROW = 18;
const ERROR_RE = /\b(error|err!|exception|traceback|fatal|failed|critical|panic|unhandled)\b/i;

interface Props {
  ids: string[];
  /** Prefix each line with its service's tag (merged streams). */
  tagged?: boolean;
  compact?: boolean;
  /** Service id whose stdin the input box writes to. */
  inputFor?: string;
  empty?: ReactNode;
}

export function LogView({ ids, tagged = false, compact = false, inputFor, empty }: Props) {
  const key = ids.join("|");
  const version = useLogTick((s) => ids.reduce((acc, id) => acc + (s.perService[id] ?? 0), 0));
  const services = useStore(selectServices);
  const tags = useMemo(() => {
    const m = new Map<string, { name: string; color: string }>();
    services.forEach((s) => m.set(s.id, { name: s.name, color: SERVICE_COLORS[s.color] }));
    return m;
  }, [services]);

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(!compact);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [times, setTimes] = useState(!compact);
  const [follow, setFollow] = useState(true);
  const [seenSeq, setSeenSeq] = useState(0);

  const all = useMemo(() => getMerged(ids), [key, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!q && !errorsOnly) return all;
    return all.filter((e) => (!errorsOnly || e.stream === "system" || ERROR_RE.test(e.plain)) && (!q || e.plain.toLowerCase().includes(q)));
  }, [all, q, errorsOnly]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 30,
  });

  useEffect(() => {
    virt.measure();
  }, [wrap, times, tagged]); // eslint-disable-line react-hooks/exhaustive-deps

  const followRef = useRef(true);
  const lastTop = useRef(0);
  const lastSeq = rows.length ? rows[rows.length - 1].seq : 0;

  const pinToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Follow the tail unless the reader scrolled away. Keyed on the last line's
  // seq: a single service's buffer is mutated in place, so `rows` can keep its identity.
  useLayoutEffect(() => {
    if (!followRef.current || !rows.length) return;
    pinToBottom();
    // Wrapped rows are measured after paint; pin again once they settle.
    const raf = requestAnimationFrame(pinToBottom);
    setSeenSeq(lastSeq);
    return () => cancelAnimationFrame(raf);
  }, [lastSeq, rows.length, follow, wrap, times]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only the reader scrolls up; our own scrolling only ever moves down.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2;
    const movedUp = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    const next = atBottom ? true : movedUp ? false : followRef.current;
    if (next !== followRef.current) {
      followRef.current = next;
      setFollow(next);
    }
  };

  // Catch the reader's intent before the next pin can undo their scroll:
  // scroll events arrive a frame late, after new lines may have re-pinned.
  const stopFollowing = () => {
    if (!followRef.current) return;
    followRef.current = false;
    setFollow(false);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) stopFollowing();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (["ArrowUp", "PageUp", "Home"].includes(e.key)) stopFollowing();
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A press on the scrollbar track/thumb (outside the content box).
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    if (e.clientX > r.left + el.clientWidth || e.clientY > r.top + el.clientHeight) stopFollowing();
  };

  const unseen = follow ? 0 : rows.filter((r) => r.seq > seenSeq).length;
  const jump = () => {
    followRef.current = true;
    setFollow(true);
    pinToBottom();
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-rail">
      <div className={cx("flex flex-none items-center gap-1 border-b border-line", compact ? "h-7 px-1.5" : "h-9 px-2")}>
        {searchOpen ? (
          <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-bg pl-2 focus-within:border-paper/70 sm:max-w-80">
            <Search className="size-3 flex-none text-fg-3" aria-hidden />
            <input
              className="h-full min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-fg-3"
              placeholder="Filter lines"
              value={query}
              autoFocus={compact}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  if (compact) setSearchOpen(false);
                }
              }}
              aria-label="Filter log lines"
            />
            {query && (
              <IconButton size="sm" label="Clear filter" onClick={() => setQuery("")}>
                <X />
              </IconButton>
            )}
          </div>
        ) : (
          <IconButton size="sm" label="Filter lines" onClick={() => setSearchOpen(true)}>
            <Search />
          </IconButton>
        )}
        {(q || errorsOnly) && (
          <span className="flex-none px-1 font-mono text-xs text-fg-3 tabular-nums">
            {rows.length}/{all.length}
          </span>
        )}
        <span className="flex-1" />
        <IconButton size="sm" label="Only errors" pressed={errorsOnly} onClick={() => setErrorsOnly((v) => !v)}>
          <TriangleAlert />
        </IconButton>
        <IconButton size="sm" label="Timestamps" pressed={times} onClick={() => setTimes((v) => !v)}>
          <Clock />
        </IconButton>
        <IconButton size="sm" label="Wrap lines" pressed={wrap} onClick={() => setWrap((v) => !v)}>
          <WrapText />
        </IconButton>
        <IconButton size="sm" label="Clear logs" onClick={() => clearLogs(ids)} disabled={!all.length}>
          <Trash2 />
        </IconButton>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto py-1.5 font-mono text-sm leading-[18px] select-text"
      >
        {rows.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center font-sans text-base text-fg-3 select-none">
            {all.length ? "No lines match this filter." : (empty ?? "No output yet.")}
          </div>
        ) : (
          <div className="relative min-w-full" style={{ height: virt.getTotalSize() }}>
            {virt.getVirtualItems().map((item) => (
              <div
                key={rows[item.index].seq}
                data-index={item.index}
                ref={wrap ? virt.measureElement : undefined}
                className="absolute top-0 left-0 min-w-full"
                style={{ transform: `translateY(${item.start}px)`, height: wrap ? undefined : ROW }}
              >
                <Line entry={rows[item.index]} times={times} wrap={wrap} tag={tagged ? tags.get(rows[item.index].id) : undefined} query={q} />
              </div>
            ))}
          </div>
        )}
      </div>

      {(unseen > 0 || (!follow && rows.length > 0)) && (
        <button
          onClick={jump}
          className={cx(
            "absolute right-4 flex h-7 items-center gap-1.5 rounded-full px-3 text-sm font-semibold shadow-[0_6px_18px_rgb(0_0_0/0.45)] animate-pop [&_svg]:size-3.5",
            inputFor ? "bottom-14" : "bottom-4",
            unseen > 0 ? "bg-paper text-ink" : "border border-line-strong bg-surface-2 text-fg-2",
          )}
        >
          <ArrowDown /> {unseen > 0 ? `${unseen > 999 ? "999+" : unseen} new` : "Latest"}
        </button>
      )}

      {inputFor && <StdinBar id={inputFor} />}
    </div>
  );
}

const Line = memo(function Line({
  entry,
  times,
  wrap,
  tag,
  query,
}: {
  entry: LogEntry;
  times: boolean;
  wrap: boolean;
  tag?: { name: string; color: string };
  query: string;
}) {
  const body = useMemo(() => {
    if (query) return highlight(entry.plain, query);
    return parseAnsi(entry.text).map((s, i) =>
      s.fg || s.bg || s.bold || s.dim || s.italic || s.underline ? (
        <span
          key={i}
          style={{
            color: s.fg,
            background: s.bg,
            fontWeight: s.bold ? 600 : undefined,
            opacity: s.dim ? 0.65 : undefined,
            fontStyle: s.italic ? "italic" : undefined,
            textDecoration: s.underline ? "underline" : undefined,
          }}
        >
          {s.text}
        </span>
      ) : (
        s.text
      ),
    );
  }, [entry, query]);

  const isError = entry.stream !== "system" && ERROR_RE.test(entry.plain);
  return (
    <div
      className={cx(
        "flex gap-3 px-3 hover:bg-white/[0.03]",
        isError && "bg-bad/[0.07] hover:bg-bad/10",
        entry.stream === "system" && "text-fg-3 italic",
        entry.stream === "stderr" && !isError && "text-[#d9d4c4]",
      )}
    >
      {times && <span className="flex-none text-fg-3/70 tabular-nums">{formatClock(entry.ts)}</span>}
      {tag && (
        <span className="w-36 flex-none truncate font-semibold" style={{ color: tag.color }} title={tag.name}>
          {tag.name}
        </span>
      )}
      <span className={cx("min-w-0", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre")}>{body}</span>
    </div>
  );
});

function highlight(text: string, q: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) break;
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={k++}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  out.push(text.slice(i));
  return out;
}

function StdinBar({ id }: { id: string }) {
  const live = useStore((s) => s.runtime[id]?.status === "running");
  const [text, setText] = useState("");
  const send = async () => {
    try {
      await api.sendInput(id, text);
      setText("");
    } catch (e) {
      toast("error", "Couldn't send input", String(e));
    }
  };
  return (
    <form
      className="flex h-10 flex-none items-center gap-2 border-t border-line bg-surface px-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (live) void send();
      }}
    >
      <span className="font-mono text-fg-3" aria-hidden>
        ›
      </span>
      <input
        className="h-full min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-fg-3 disabled:opacity-60"
        placeholder={live ? "Send input to the process (stdin)" : "Start the service to send input"}
        value={text}
        disabled={!live}
        onChange={(e) => setText(e.target.value)}
        aria-label="Send input to process"
      />
      <IconButton size="sm" label="Send" type="submit" disabled={!live}>
        <CornerDownLeft />
      </IconButton>
    </form>
  );
}
