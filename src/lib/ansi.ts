/** Minimal SGR parser: turns ANSI-coloured output into styled segments. */

export interface Segment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

// Tuned for the steel ground; normal and bright variants.
const BASIC = ["#4a4f55", "#f2706b", "#5ccf6f", "#e7c15a", "#7aa2f7", "#c28cf2", "#4fc8d8", "#d6d3cc"];
const BRIGHT = ["#7d848b", "#ff8f8a", "#7ee08e", "#f3d57d", "#9dbbff", "#d7aaff", "#7fe0ec", "#f5f3ee"];

function xterm256(n: number): string {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g;

export function stripAnsi(s: string): string {
  return s.indexOf("\x1b") === -1 ? s : s.replace(ESC, "");
}

export function parseAnsi(input: string): Segment[] {
  if (input.indexOf("\x1b") === -1) return [{ text: input }];
  const out: Segment[] = [];
  let style: Omit<Segment, "text"> = {};
  let last = 0;
  ESC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC.exec(input))) {
    if (m.index > last) out.push({ text: input.slice(last, m.index), ...style });
    last = ESC.lastIndex;
    if (m[2] !== "m") continue;
    const codes = (m[1] || "0").split(";").map((c) => parseInt(c || "0", 10));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 22) style.bold = style.dim = false;
      else if (c === 23) style.italic = false;
      else if (c === 24) style.underline = false;
      else if (c >= 30 && c <= 37) style.fg = BASIC[c - 30];
      else if (c >= 90 && c <= 97) style.fg = BRIGHT[c - 90];
      else if (c === 39) style.fg = undefined;
      else if (c >= 40 && c <= 47) style.bg = BASIC[c - 40];
      else if (c >= 100 && c <= 107) style.bg = BRIGHT[c - 100];
      else if (c === 49) style.bg = undefined;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const col = xterm256(codes[i + 2] ?? 0);
        if (c === 38) style.fg = col;
        else style.bg = col;
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        if (c === 38) style.fg = col;
        else style.bg = col;
        i += 4;
      }
    }
  }
  if (last < input.length) out.push({ text: input.slice(last), ...style });
  return out;
}
