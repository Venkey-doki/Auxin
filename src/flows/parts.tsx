/** Building blocks shared by the Flows screen (styled after the approved prototype). */
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cx } from "../components/ui";
import { SERVICE_COLORS } from "../lib/util";
import type { KV } from "./model";
import { lookup, type VarSources } from "./vars";

/** Method colours, Insomnia-style, drawn from Auxin's identity palette. */
export const METHOD_COLOR: Record<string, string> = {
  GET: "#7aa2f7",
  POST: "#9fd36c",
  PUT: "#e0b46c",
  PATCH: "#c49bf2",
  DELETE: "#f08a9b",
  HEAD: "#a9b8d6",
  OPTIONS: "#a9b8d6",
};
export const METHODS = Object.keys(METHOD_COLOR);

/** Queue steps' badges: publish and subscribe (wait for a message). */
const QUEUE_COLOR: Record<string, string> = { PUB: "#76c8bd", SUB: "#d7b46e" };

export function MethodBadge({ method }: { method: string }) {
  const c = METHOD_COLOR[method] ?? QUEUE_COLOR[method] ?? "#a9b8d6";
  return (
    <span className="inline-grid h-5 w-14 flex-none place-items-center rounded font-mono text-[11px] font-semibold" style={{ color: c, background: `color-mix(in oklab, ${c} 16%, transparent)` }}>
      {method}
    </span>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, right }: { tabs: { id: T; label: ReactNode; count?: number; dot?: boolean }[]; value: T; onChange: (t: T) => void; right?: ReactNode }) {
  return (
    <div className="flex h-9 flex-none items-end gap-4 border-b border-line px-3" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx("relative -mb-px flex h-9 items-center gap-1.5 border-b-2 text-sm transition-colors", value === t.id ? "border-paper text-fg" : "border-transparent text-fg-3 hover:text-fg-2")}
        >
          {t.label}
          {t.count ? <span className="font-mono text-xs text-fg-3">{t.count}</span> : null}
          {t.dot && <span className="size-1.5 rounded-full bg-warm" aria-label="needs attention" />}
        </button>
      ))}
      <span className="flex-1" />
      {right && <span className="flex h-9 items-center">{right}</span>}
    </div>
  );
}

/**
 * Single-line input that highlights {{variables}} by mirroring the text
 * underneath: known ones in paper, a service tinted with its identity colour,
 * unknown ones in amber.
 */
export function VarInput({
  value,
  onChange,
  src,
  serviceColors,
  placeholder,
  label,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  src: VarSources;
  serviceColors: Record<string, number>;
  placeholder?: string;
  label: string;
  onEnter?: () => void;
}) {
  const parts = value.split(/(\{\{\s*[\w.$-]+\s*\}\})/g);
  return (
    <div className="relative min-w-0 flex-1">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden px-2.5 font-mono text-sm leading-8 whitespace-pre text-fg">
        {parts.map((p, i) => {
          const m = /^\{\{\s*([\w.$-]+)\s*\}\}$/.exec(p);
          if (!m) return <span key={i}>{p}</span>;
          const known = lookup(m[1], src);
          const color = serviceColors[m[1]];
          return (
            <span
              key={i}
              className={cx("rounded-sm", known ? "text-paper" : "text-warm")}
              style={{ background: color != null ? `color-mix(in oklab, ${SERVICE_COLORS[color]} 22%, transparent)` : "var(--color-surface-3)" }}
            >
              {p}
            </span>
          );
        })}
      </div>
      <input
        className="relative h-8 w-full bg-transparent px-2.5 font-mono text-sm text-transparent outline-none [caret-color:var(--color-fg)] selection:bg-paper/20 placeholder:text-fg-3"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
        spellCheck={false}
        aria-label={label}
      />
    </div>
  );
}

export function KVTable({
  rows,
  onChange,
  keyPh,
  valPh,
  hint,
  secret,
  keyMono = true,
}: {
  rows: KV[];
  onChange: (r: KV[]) => void;
  keyPh: string;
  valPh: string;
  hint?: ReactNode;
  secret?: boolean;
  keyMono?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const cell = "h-8 w-full bg-transparent px-2.5 text-sm text-fg outline-none placeholder:text-fg-3 focus:bg-rail";
  return (
    <div className="grid gap-2">
      <div className="overflow-hidden rounded-md border border-line">
        {rows.map((r, i) => (
          <div key={i} className="group grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_28px] divide-x divide-line border-b border-line">
            <input className={cx(cell, keyMono && "font-mono")} value={r.key} placeholder={keyPh} aria-label="Name" spellCheck={false} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <input
              className={cx(cell, "font-mono")}
              type={secret && !reveal ? "password" : "text"}
              value={r.value}
              placeholder={valPh}
              aria-label="Value"
              spellCheck={false}
              onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            <button className="grid place-items-center text-fg-3 opacity-0 group-hover:opacity-100 hover:text-bad-soft focus-visible:opacity-100" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove row">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        <div className="flex">
          <button className="flex h-8 flex-1 items-center gap-1.5 px-2.5 text-sm text-fg-3 hover:bg-surface-2 hover:text-fg-2" onClick={() => onChange([...rows, { key: "", value: "" }])}>
            <Plus className="size-3.5" /> Add
          </button>
          {secret && rows.length > 0 && (
            <button className="flex h-8 items-center gap-1.5 px-2.5 text-sm text-fg-3 hover:text-fg-2" onClick={() => setReveal((v) => !v)} aria-pressed={reveal}>
              {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} {reveal ? "Hide" : "Show"} values
            </button>
          )}
        </div>
      </div>
      {hint && <span className="text-xs text-fg-3">{hint}</span>}
    </div>
  );
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Syntax-coloured JSON. Large documents render as plain text to stay fast. */
export function Json({ text }: { text: string }) {
  if (text.length > 200_000) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  JSON_TOKEN.lastIndex = 0;
  while ((m = JSON_TOKEN.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] && m[2]) out.push(<span key={k++} className="text-fg-2">{m[1]}</span>, m[2]);
    else if (m[1]) out.push(<span key={k++} className="text-[#9fd36c]">{m[1]}</span>);
    else if (m[3]) out.push(<span key={k++} className="text-[#c49bf2]">{m[3]}</span>);
    else out.push(<span key={k++} className="text-[#e0b46c]">{m[4]}</span>);
    last = JSON_TOKEN.lastIndex;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}
