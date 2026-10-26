import { Play, Rows3, Search, Square, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { activeWorkspace, isLive, navigate, selectServices, setPalette, startService, stopService, useStore } from "../state/store";
import { allSteps } from "../flows/model";
import { runFlow } from "../flows/runner";
import { useFlows } from "../flows/store";
import { shownStatus, STATUS_TEXT, StatusMark } from "./status";
import { cx } from "./ui";

interface Item {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const ws = useStore((s) => activeWorkspace(s));
  const flowMap = useFlows((s) => s.flows);
  const flows = useMemo(() => Object.values(flowMap), [flowMap]);
  const services = useStore(selectServices);
  const runtime = useStore((s) => s.runtime);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const now = Date.now();
    const out: Item[] = [];
    for (const s of services) {
      const st = shownStatus(runtime[s.id], now);
      out.push({ id: "svc" + s.id, label: s.name, hint: "Open service", icon: <StatusMark status={st} className={STATUS_TEXT[st]} />, run: () => navigate({ type: "service", id: s.id }) });
      out.push(
        isLive(runtime[s.id])
          ? { id: "stop" + s.id, label: `Stop ${s.name}`, hint: "Service", icon: <Square />, run: () => void stopService(s.id) }
          : { id: "start" + s.id, label: `Start ${s.name}`, hint: "Service", icon: <Play />, run: () => void startService(s.id) },
      );
    }
    for (const f of flows) {
      out.push({ id: "f" + f.path, label: f.name, hint: `Flow · ${allSteps(f.steps).length} requests`, icon: <Workflow />, run: () => navigate({ type: "flow", id: f.path }) });
      if (f.steps.length) out.push({ id: "rf" + f.path, label: `Run ${f.name}`, hint: "Flow", icon: <Play />, run: () => (navigate({ type: "flow", id: f.path }), void runFlow(f.path)) });
    }
    for (const g of ws?.groups ?? []) {
      out.push({ id: "g" + g.id, label: g.name, hint: "Open group", icon: <Rows3 />, run: () => navigate({ type: "group", id: g.id }) });
    }
    return out;
  }, [services, runtime, ws, flows]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    const words = t.split(/\s+/);
    return items.filter((i) => words.every((w) => i.label.toLowerCase().includes(w) || i.hint.toLowerCase().includes(w)));
  }, [items, q]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const choose = (i: Item | undefined) => {
    if (!i) return;
    setPalette(false);
    i.run();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-center bg-black/45 pt-[14vh]" onMouseDown={() => setPalette(false)}>
      <div
        role="dialog"
        aria-label="Jump to"
        className="flex h-fit max-h-[60vh] w-[560px] flex-col overflow-hidden rounded-xl border border-line-strong bg-pop shadow-[0_24px_64px_rgb(0_0_0/0.6)] animate-pop"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 flex-none items-center gap-3 border-b border-line px-4">
          <Search className="size-4 text-fg-3" aria-hidden />
          <input
            autoFocus
            className="h-full flex-1 bg-transparent text-lg outline-none placeholder:text-fg-3"
            placeholder="Start a service, run a flow, open a group…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                choose(filtered[sel]);
              } else if (e.key === "Escape") {
                setPalette(false);
              }
            }}
            aria-label="Search"
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox">
          {filtered.map((i, idx) => (
            <button
              key={i.id}
              data-idx={idx}
              role="option"
              aria-selected={idx === sel}
              onMouseMove={() => setSel(idx)}
              onClick={() => choose(i)}
              className={cx("flex h-9 w-full items-center gap-3 rounded-md px-3 text-left [&_svg]:size-3.5 [&_svg]:flex-none", idx === sel ? "bg-surface-3 text-fg" : "text-fg-2")}
            >
              <span className="grid w-4 place-items-center text-fg-3">{i.icon}</span>
              <span className="min-w-0 flex-1 truncate">{i.label}</span>
              <span className="flex-none text-sm text-fg-3">{i.hint}</span>
            </button>
          ))}
          {!filtered.length && <p className="px-3 py-4 text-base text-fg-3">Nothing matches “{q}”.</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
