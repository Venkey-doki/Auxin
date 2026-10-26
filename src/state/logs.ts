import { create } from "zustand";
import { stripAnsi } from "../lib/ansi";
import type { LogEvent } from "../lib/api";

export interface LogEntry {
  seq: number;
  id: string;
  ts: number;
  stream: LogEvent["stream"];
  text: string;
  /** ANSI-free text, for search and port detection. */
  plain: string;
}

const PER_SERVICE = 10_000;

/**
 * Log lines live outside React state (they arrive by the thousand); components
 * subscribe to `tick` and read the buffers directly.
 */
const buffers = new Map<string, LogEntry[]>();
let seq = 0;

type Listener = (entries: LogEntry[]) => void;
const listeners = new Set<Listener>();

export const useLogTick = create<{ tick: number; perService: Record<string, number> }>(() => ({ tick: 0, perService: {} }));

export function appendLogs(events: LogEvent[]): LogEntry[] {
  const added: LogEntry[] = [];
  const touched: Record<string, number> = {};
  for (const e of events) {
    const entry: LogEntry = { seq: ++seq, id: e.id, ts: e.ts, stream: e.stream, text: e.text, plain: stripAnsi(e.text) };
    let buf = buffers.get(e.id);
    if (!buf) buffers.set(e.id, (buf = []));
    buf.push(entry);
    if (buf.length > PER_SERVICE) buf.splice(0, buf.length - PER_SERVICE);
    added.push(entry);
    touched[e.id] = seq;
  }
  useLogTick.setState((s) => ({ tick: s.tick + 1, perService: { ...s.perService, ...touched } }));
  listeners.forEach((l) => l(added));
  return added;
}

export function systemLog(id: string, text: string) {
  appendLogs([{ id, stream: "system", text, ts: Date.now() }]);
}

export function getLogs(id: string): LogEntry[] {
  return buffers.get(id) ?? [];
}

/** Lines from several services, interleaved in arrival order. */
export function getMerged(ids: string[]): LogEntry[] {
  if (ids.length === 1) return getLogs(ids[0]);
  const lists = ids.map(getLogs).filter((l) => l.length);
  if (lists.length <= 1) return lists[0] ?? [];
  const out: LogEntry[] = [];
  const idx = lists.map(() => 0);
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      if (idx[i] < lists[i].length && (best < 0 || lists[i][idx[i]].seq < lists[best][idx[best]].seq)) best = i;
    }
    if (best < 0) break;
    out.push(lists[best][idx[best]++]);
  }
  return out;
}

export function clearLogs(ids: string[]) {
  ids.forEach((id) => buffers.delete(id));
  useLogTick.setState((s) => {
    const perService = { ...s.perService };
    ids.forEach((id) => (perService[id] = ++seq));
    return { tick: s.tick + 1, perService };
  });
}

export function onLogLines(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
