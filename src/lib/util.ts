/** Stable identity colours for services; tags only, never chrome. */
export const SERVICE_COLORS = [
  "#7aa2f7",
  "#e0b46c",
  "#c49bf2",
  "#4fc8d8",
  "#f08a9b",
  "#9fd36c",
  "#ff9f6b",
  "#6fd6bd",
  "#d9a3e0",
  "#a9b8d6",
];

export function hashColor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % SERVICE_COLORS.length;
}

export function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 9);
}

const ANNOUNCE = /\b(listening|listen|running on|started|serving|server|ready|available)\b|\b(local|network):/i;
const PORT_URL = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/;
const PORT_WORD = /\bport\s*[:=]?\s*(\d{2,5})\b/i;

/**
 * Pulls the port a dev server announces ("Listening on http://localhost:3000").
 * Only announcement lines count, so "Connected to Redis at :6379" is ignored.
 */
export function detectPort(plain: string): number | undefined {
  if (!ANNOUNCE.test(plain) || /\b(connect(ed|ing)?|to redis|database|db at)\b/i.test(plain)) return undefined;
  const m = PORT_URL.exec(plain) || PORT_WORD.exec(plain);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 80 && n <= 65535 ? n : undefined;
}

export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";
