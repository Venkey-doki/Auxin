/** Parses a pasted `curl …` command into a request. Covers what browsers and API docs emit. */

export interface ParsedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  /** Problems we recovered from, worth showing the user (e.g. an unclosed quote). */
  warnings?: string[];
}

/**
 * Shell-style split: quotes, escapes and line continuations. Each continued
 * line is tokenized on its own, so a quote left open (often after deleting a
 * token from a header) is closed at the end of its line instead of
 * swallowing the rest of the command.
 */
function tokenize(input: string, warnings: string[]): string[] {
  const out: string[] = [];
  input
    .split(/\\\r?\n/)
    .forEach((line, n) => {
      const open = tokenizeLine(line, out);
      if (open) warnings.push(`Line ${n + 1} has an unclosed ${open === "'" ? "single" : "double"} quote; it was closed at the end of the line.`);
    });
  return out;
}

/** Appends one line's tokens to `out`; returns the quote left open, if any. */
function tokenizeLine(line: string, out: string[]): '"' | "'" | null {
  const s = line.trim();
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else if (c === "$" && s[i + 1] === "'") {
      // $'…' ANSI-C quoting (Chrome's "Copy as cURL (bash)")
      continue;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(quote ? cur.trimEnd() : cur);
  return quote;
}

export function parseCurl(input: string): ParsedRequest | null {
  const warnings: string[] = [];
  const t = tokenize(input, warnings);
  if (!t.length || t[0] !== "curl") return null;
  let method = "";
  let url = "";
  const headers: [string, string][] = [];
  const data: string[] = [];
  let json = false;

  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    const next = () => t[++i] ?? "";
    if (a === "-X" || a === "--request") method = next().toUpperCase();
    else if (a === "-H" || a === "--header") {
      const h = next();
      const k = h.indexOf(":");
      if (k > 0) headers.push([h.slice(0, k).trim(), h.slice(k + 1).trim()]);
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"].includes(a)) data.push(next());
    else if (a === "--json") {
      data.push(next());
      json = true;
    } else if (a === "-u" || a === "--user") headers.push(["Authorization", `Basic ${btoa(next())}`]);
    else if (a === "--url") url = next();
    else if (a === "-A" || a === "--user-agent") headers.push(["User-Agent", next()]);
    else if (a === "-b" || a === "--cookie") headers.push(["Cookie", next()]);
    else if (a === "-I" || a === "--head") method = "HEAD";
    else if (/^-[a-zA-Z]$|^--[a-z-]+$/.test(a)) {
      // Flags with a value we don't model; skip the value when it's clearly one.
      if (["-o", "--output", "-m", "--max-time", "--connect-timeout", "-w", "--write-out", "-e", "--referer"].includes(a)) i++;
    } else if (!url) url = a;
  }

  const lower = headers.map(([k]) => k.toLowerCase());
  if (json && !lower.includes("content-type")) headers.push(["Content-Type", "application/json"]);
  if (json && !lower.includes("accept")) headers.push(["Accept", "application/json"]);
  if (!url) return null;
  if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
  for (const [k, v] of headers) if (/^authorization$/i.test(k) && /^(Bearer|Basic|Token)\s*$/i.test(v)) warnings.push(`The ${k} header has no token. Add it, or use a {{variable}} like Bearer {{token}}.`);
  return { method: method || (data.length ? "POST" : "GET"), url, headers, body: data.join("&"), warnings: warnings.length ? warnings : undefined };
}

export function toCurl(r: ParsedRequest): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${r.method} ${q(r.url)}`];
  r.headers.forEach(([k, v]) => parts.push(`-H ${q(`${k}: ${v}`)}`));
  if (r.body) parts.push(`--data-raw ${q(r.body)}`);
  return parts.join(" \\\n  ");
}
