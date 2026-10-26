/**
 * An open request: the request editor (body, headers, extract, checks, poll,
 * retry, curl) beside its response and trace.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowRight, Copy, FileJson, FolderOpen, Play, Plus, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusMark } from "../components/status";
import { Button, cx, IconButton, inputClass, Seg, SegButton } from "../components/ui";
import { api } from "../lib/api";
import { toCurl } from "../lib/curl";
import { formatClock, SERVICE_COLORS } from "../lib/util";
import { selectServices, startService, toast, useStore } from "../state/store";
import { allSteps, CHECK_OPS, outsideWorkspace, type BodyKind, type Check, type CheckOp, type FlowDoc, type FlowStep } from "./model";
import { formatBytes, formatMs, Json, KVTable, METHOD_COLOR, METHODS, Tabs, VarInput } from "./parts";
import { QueueDetail } from "./QueueDetail";
import { SpanWaterfall } from "./SpanWaterfall";
import { cancelStep, sendStep, type StepOutcome } from "./runner";
import { rk, serviceIdFor, updateStep, useFlows, varSources } from "./store";
import type { TraceLine } from "./trace";
import { resolve, resolveHidingSecrets } from "./vars";

/* ---------------- request | response ---------------- */

type ReqTab = "body" | "headers" | "extract" | "checks" | "poll" | "retry" | "curl";
const BODY_KINDS: { id: BodyKind; label: string }[] = [
  { id: "none", label: "None" },
  { id: "json", label: "JSON" },
  { id: "text", label: "Text" },
  { id: "form", label: "Form" },
  { id: "file", label: "File" },
];

function useServiceColors(doc: FlowDoc) {
  const services = useStore(selectServices);
  return useMemo(() => {
    const m: Record<string, number> = Object.fromEntries(services.map((s) => [s.name, s.color]));
    for (const f of doc.services) {
      const svc = services.find((s) => s.id === serviceIdFor(f.ref));
      if (svc) m[f.alias] = svc.color;
    }
    return m;
  }, [services, doc.services]);
}

/** An open step: a request editor, or a queue step's (publish / wait for a message). */
export function StepDetail(props: { doc: FlowDoc; step: FlowStep; locked: boolean; onRemove: () => void }) {
  return props.step.queue ? <QueueDetail {...props} /> : <HttpDetail {...props} />;
}

function HttpDetail({ doc, step, locked, onRemove }: { doc: FlowDoc; step: FlowStep; locked: boolean; onRemove: () => void }) {
  const path = doc.path;
  const out = useFlows((s) => s.responses[rk(path, step.id)]);
  const invalid = useFlows((s) => s.invalid[rk(path, step.id)]);
  const extracted = useFlows((s) => s.extracted[path]);
  useFlows((s) => s.envs);
  useStore((s) => s.runtime);
  const colors = useServiceColors(doc);
  const src = varSources(doc, extracted);
  const [tab, setTab] = useState<ReqTab>(step.body.kind !== "none" ? "body" : "headers");
  const busy = out?.state === "sending" || out?.state === "polling";
  const patch = (p: Partial<FlowStep>) => updateStep(path, step.id, p);
  const preview = resolveHidingSecrets(step.url, src);
  const missing = resolve(step.url, src).missing;
  // A request in an if lane the last run didn't take was never meant to run.
  const branches = useFlows((s) => s.runs[path]?.branches);
  const block = doc.steps.find((i) => i.type === "if" && [...i.then, ...i.else].some((x) => x.id === step.id));
  const notTaken = block?.type === "if" && !!branches?.[block.id] && !block[branches[block.id]].some((x) => x.id === step.id);
  const fromEarlier = missing.filter((m) => allSteps(doc.steps).some((s) => s.id !== step.id && s.extract.some((e) => e.key === m)));

  return (
    // Side by side when there's room; stacked when a side panel narrows the view.
    <div className="@container border-t border-line bg-bg">
      <div className="grid grid-cols-1 divide-y divide-line @[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @[860px]:divide-x @[860px]:divide-y-0">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 px-3 pt-3">
            <input
              className="h-7 min-w-0 flex-1 rounded px-1.5 text-base font-semibold outline-none hover:bg-surface-2 focus:bg-rail"
              value={step.name}
              onChange={(e) => patch({ name: e.target.value })}
              aria-label="Request name"
            />
            <IconButton label="Delete request" onClick={onRemove} disabled={locked}>
              <Trash2 />
            </IconButton>
          </div>
          <div className="flex items-center gap-2 p-3">
            <div className="flex min-w-0 flex-1 items-center rounded-md border border-line-strong bg-rail focus-within:border-paper/70">
              <select
                className="h-8 flex-none appearance-none rounded-l-md bg-transparent pr-6 pl-2.5 font-mono text-xs font-semibold"
                style={{ color: METHOD_COLOR[step.method] }}
                value={step.method}
                onChange={(e) => patch({ method: e.target.value })}
                aria-label="Method"
              >
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <span className="h-5 w-px bg-line-strong" aria-hidden />
              <VarInput
                value={step.url}
                onChange={(url) => patch({ url })}
                src={src}
                serviceColors={colors}
                placeholder="{{service}}/path"
                label="URL"
                onEnter={() => !locked && void sendStep(path, step)}
              />
            </div>
            {busy ? (
              <Button className="h-8" onClick={() => cancelStep(path, step.id)} disabled={locked}>
                <Square /> Cancel
              </Button>
            ) : (
              <Button variant="primary" className="h-8" onClick={() => void sendStep(path, step)} disabled={!step.url.trim() || locked}>
                <Play /> Send
              </Button>
            )}
          </div>
          <div className={cx("-mt-1 truncate px-3 pb-2 font-mono text-xs", missing.length ? "text-warm" : "text-fg-3")} title={preview}>
            {step.url ? preview : "Type a URL, or start with {{service-name}}"}
            {missing.length > 0 &&
              (fromEarlier.length === missing.length ? "  · filled in by an earlier request" : `  · no value for ${missing.map((m) => `{{${m}}}`).join(", ")}`)}
          </div>
          <Tabs
            tabs={[
              { id: "body", label: "Body", dot: !!invalid },
              { id: "headers", label: "Headers", count: step.headers.filter((h) => h.key.trim()).length },
              { id: "extract", label: "Extract", count: step.extract.filter((e) => e.key.trim()).length },
              { id: "checks", label: "Checks", count: step.checks.filter((c) => c.left.trim()).length },
              { id: "poll", label: step.poll ? "Poll · on" : "Poll" },
              { id: "retry", label: step.retry || step.onFailure === "continue" ? "Retry · on" : "Retry" },
              { id: "curl", label: "curl" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <div className="h-[340px] overflow-y-auto p-3">
            {tab === "body" && <BodyEditor path={path} step={step} invalid={invalid} />}
            {tab === "headers" && (
              <KVTable
                rows={step.headers}
                onChange={(headers) => patch({ headers })}
                keyPh="Header"
                valPh="Value · {{variables}} work here"
                hint={doc.injectHeaders ? "Auxin also adds X-Request-ID and traceparent so it can trace this request through your services' logs." : undefined}
              />
            )}
            {tab === "extract" && (
              <KVTable
                rows={step.extract}
                onChange={(extract) => patch({ extract })}
                keyPh="variable, e.g. jobId"
                valPh="body.jobId · header.location · body.items[0].id"
                hint={
                  <>
                    Each value becomes <span className="font-mono">{"{{variable}}"}</span> for the requests after this one.
                  </>
                }
              />
            )}
            {tab === "checks" && (
              <ChecksEditor
                checks={step.checks}
                onChange={(checks) => patch({ checks })}
                note={
                  step.onFailure === "continue"
                    ? "If a check fails, the request fails and the flow keeps going."
                    : "If a check fails, the flow stops here and later requests are skipped."
                }
                empty="With no checks, the request passes when the status is below 400."
              />
            )}
            {tab === "poll" && <PollEditor step={step} onChange={(poll) => patch({ poll })} />}
            {tab === "retry" && <RetryEditor step={step} onChange={patch} />}
            {tab === "curl" && <CurlExport doc={doc} step={step} />}
          </div>
        </div>
        <ResponsePanel doc={doc} out={out} notTaken={notTaken} onCancel={() => cancelStep(path, step.id)} />
      </div>
    </div>
  );
}

/** `note` is shown under the rows once there are checks; `empty` before. `first` is the row "Add check" starts with. */
export function ChecksEditor({
  checks,
  onChange,
  note,
  empty,
  first = { left: "status", op: "==", right: "200" },
}: {
  checks: Check[];
  onChange: (c: Check[]) => void;
  note?: string;
  empty?: string;
  first?: Check;
}) {
  const cell = "h-8 w-full bg-transparent px-2.5 font-mono text-sm text-fg outline-none placeholder:text-fg-3 focus:bg-rail";
  return (
    <div className="grid gap-2">
      <div className="overflow-hidden rounded-md border border-line">
        {checks.map((c, i) => {
          const set = (p: Partial<Check>) => onChange(checks.map((x, j) => (j === i ? { ...x, ...p } : x)));
          const unary = c.op === "exists" || c.op === "!exists";
          return (
            <div key={i} className="group grid grid-cols-[minmax(0,2fr)_112px_minmax(0,2fr)_28px] divide-x divide-line border-b border-line">
              <input
                className={cell}
                value={c.left}
                placeholder="status · body.status · time"
                onChange={(e) => set({ left: e.target.value })}
                aria-label="What to check"
                spellCheck={false}
              />
              <select
                className="h-8 appearance-none bg-transparent px-2 font-mono text-sm text-fg outline-none focus:bg-rail"
                value={c.op}
                onChange={(e) => set({ op: e.target.value as CheckOp })}
                aria-label="Operator"
              >
                {CHECK_OPS.map((op) => (
                  <option key={op}>{op}</option>
                ))}
              </select>
              <input
                className={cell}
                value={unary ? "" : c.right}
                disabled={unary}
                placeholder={unary ? "" : '200 · "done" · true'}
                onChange={(e) => set({ right: e.target.value })}
                aria-label="Expected value"
                spellCheck={false}
              />
              <button
                className="grid place-items-center text-fg-3 opacity-0 group-hover:opacity-100 hover:text-bad-soft focus-visible:opacity-100"
                onClick={() => onChange(checks.filter((_, j) => j !== i))}
                aria-label="Remove check"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
        <button
          className="flex h-8 w-full items-center gap-1.5 px-2.5 text-sm text-fg-3 hover:bg-surface-2 hover:text-fg-2"
          onClick={() => onChange([...checks, checks.length ? { left: "", op: "==", right: "" } : first])}
        >
          <Plus className="size-3.5" /> Add check
        </button>
      </div>
      <span className="text-xs text-fg-3">{checks.length ? note : empty}</span>
    </div>
  );
}

/** A small number field inside a sentence; `inputClass` alone would stretch it to full width. */
export const inlineInput = inputClass.replace("w-full ", "");

function PollEditor({ step, onChange }: { step: FlowStep; onChange: (p: FlowStep["poll"]) => void }) {
  const p = step.poll;
  return (
    <div className="grid gap-3 text-sm">
      <label className="flex items-center gap-2 text-fg-2">
        <input
          type="checkbox"
          checked={!!p}
          onChange={(e) => onChange(e.target.checked ? { until: [{ left: "body.status", op: "==", right: '"done"' }], everyMs: 1000, maxTries: 30 } : null)}
        />
        Repeat this request until a condition holds
      </label>
      {p && (
        <>
          <ChecksEditor checks={p.until} onChange={(until) => onChange({ ...p, until })} />
          <div className="flex flex-wrap items-center gap-2 text-fg-2">
            Every
            <input
              className={cx(inlineInput, "h-8 w-20 font-mono text-sm")}
              type="number"
              min={0.1}
              step={0.5}
              value={p.everyMs / 1000}
              onChange={(e) => onChange({ ...p, everyMs: Math.max(100, Math.round(Number(e.target.value) * 1000) || 1000) })}
              aria-label="Seconds between tries"
            />
            seconds, at most
            <input
              className={cx(inlineInput, "h-8 w-20 font-mono text-sm")}
              type="number"
              min={1}
              value={p.maxTries}
              onChange={(e) => onChange({ ...p, maxTries: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
              aria-label="Maximum tries"
            />
            tries.
          </div>
        </>
      )}
    </div>
  );
}

/** Re-sending a failed request, and what the flow does when it still fails. */
function RetryEditor({ step, onChange }: { step: FlowStep; onChange: (p: Partial<FlowStep>) => void }) {
  const r = step.retry;
  const unsafe = !["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(step.method);
  return (
    <div className="grid gap-4 text-sm">
      <div className="grid gap-3">
        <label className="flex items-center gap-2 text-fg-2">
          <input type="checkbox" checked={!!r} onChange={(e) => onChange({ retry: e.target.checked ? { max: 2, backoffMs: 500, on: "errors" } : null })} />
          Send it again if it fails
        </label>
        {r && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-fg-2">
              Retry
              <Seg label="When to retry">
                <SegButton active={r.on === "errors"} onClick={() => onChange({ retry: { ...r, on: "errors" } })}>
                  on errors and 5xx
                </SegButton>
                <SegButton active={r.on === "any"} onClick={() => onChange({ retry: { ...r, on: "any" } })}>
                  on any failure
                </SegButton>
              </Seg>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-fg-2">
              Up to
              <input
                className={cx(inlineInput, "h-8 w-16 font-mono text-sm")}
                type="number"
                min={1}
                max={5}
                value={r.max}
                onChange={(e) => onChange({ retry: { ...r, max: Math.min(5, Math.max(1, Math.round(Number(e.target.value)) || 1)) } })}
                aria-label="Retries"
              />
              more times, waiting
              <input
                className={cx(inlineInput, "h-8 w-20 font-mono text-sm")}
                type="number"
                min={0}
                step={0.5}
                value={r.backoffMs / 1000}
                onChange={(e) => onChange({ retry: { ...r, backoffMs: Math.max(0, Math.round(Number(e.target.value) * 1000) || 0) } })}
                aria-label="Seconds before the first retry"
              />
              seconds first, then twice as long each time.
            </div>
            <span className="text-xs text-fg-3">
              {r.on === "errors"
                ? "Errors are no response at all (refused, timed out) or a 5xx status."
                : "Any failure includes failed checks and a poll that never matched."}
              {unsafe && ` A retried ${step.method} can repeat its side effect, such as creating a record twice.`}
            </span>
          </>
        )}
      </div>
      <div className="border-t border-line pt-4">
        <OnFailureEditor step={step} onChange={onChange} />
      </div>
    </div>
  );
}

/** What the flow does after this step fails. */
export function OnFailureEditor({ step, onChange }: { step: FlowStep; onChange: (p: Partial<FlowStep>) => void }) {
  return (
    <div className="grid gap-2 text-sm">
      <span className="text-fg-2">If this step still fails</span>
      <Seg label="If this step fails">
        <SegButton active={step.onFailure === "stop"} onClick={() => onChange({ onFailure: "stop" })}>
          Stop the flow
        </SegButton>
        <SegButton active={step.onFailure === "continue"} onClick={() => onChange({ onFailure: "continue" })}>
          Keep going
        </SegButton>
      </Seg>
      <span className="text-xs text-fg-3">Either way the run is marked failed. Keep going is for cleanup or best-effort steps.</span>
    </div>
  );
}

function BodyEditor({ path, step, invalid }: { path: string; step: FlowStep; invalid?: string }) {
  const root = useFlows((s) => s.root);
  const patchBody = (p: Partial<FlowStep["body"]>) => updateStep(path, step.id, { body: { ...step.body, ...p } });
  // Files outside the workspace are never sent, so they aren't read for a preview either.
  const previewPath = step.body.kind === "file" && step.body.file && root && !outsideWorkspace(step.body.file) ? `${root}/${step.body.file}` : null;
  const [preview, setPreview] = useState<{ path: string; value: { text: string; size: number } | string } | null>(null);
  useEffect(() => {
    if (!previewPath) return;
    api
      .filePreview(previewPath)
      .then(([text, size]) => setPreview({ path: previewPath, value: { text, size } }))
      .catch((e) => setPreview({ path: previewPath, value: String(e) }));
  }, [previewPath]);
  // A preview read for another file (or a slower, earlier read) is never shown.
  const filePreview = preview && preview.path === previewPath ? preview.value : null;

  const chooseFile = async () => {
    const picked = await openDialog({ multiple: false, directory: false, defaultPath: root ?? undefined, title: "Choose a body file" });
    if (typeof picked !== "string") return;
    patchBody({ file: root && picked.startsWith(root + "/") ? picked.slice(root.length + 1) : picked });
  };

  return (
    <div className="grid h-full grid-rows-[auto_1fr] gap-2">
      <div className="flex items-center gap-2">
        <Seg label="Body type">
          {BODY_KINDS.map((k) => (
            <SegButton key={k.id} active={step.body.kind === k.id} onClick={() => patchBody({ kind: k.id })}>
              {k.label}
            </SegButton>
          ))}
        </Seg>
        {invalid && <span className="truncate text-xs text-warm">{invalid}</span>}
      </div>
      {step.body.kind === "none" && <p className="text-sm text-fg-3">This request has no body.</p>}
      {(step.body.kind === "json" || step.body.kind === "text") && (
        <textarea
          className={cx(
            "h-full w-full resize-none rounded-md border bg-rail p-3 font-mono text-sm leading-5 text-fg outline-none focus:border-paper/70",
            invalid ? "border-warm/60" : "border-line",
          )}
          value={step.body.text}
          onChange={(e) => patchBody({ text: e.target.value })}
          placeholder={step.body.kind === "json" ? '{\n  "key": "value",\n  "id": "{{jobId}}"\n}' : "Plain text body"}
          spellCheck={false}
          aria-label="Body"
        />
      )}
      {step.body.kind === "form" && (
        <KVTable rows={step.body.form} onChange={(form) => patchBody({ form })} keyPh="field" valPh="value" hint="Sent as application/x-www-form-urlencoded." />
      )}
      {step.body.kind === "file" && (
        <div className="grid content-start gap-2">
          <div className="flex gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-rail px-2.5 font-mono text-sm text-fg outline-none focus:border-paper/70"
              value={step.body.file}
              onChange={(e) => patchBody({ file: e.target.value })}
              placeholder="path/relative/to/workspace.json"
              aria-label="Body file"
              spellCheck={false}
            />
            <Button className="h-8" onClick={() => void chooseFile()}>
              <FolderOpen /> Choose…
            </Button>
          </div>
          <span className="text-xs text-fg-3">
            Sent as-is (variables in the file aren't replaced). Paths are relative to the workspace, so teammates can use the same flow.
          </span>
          {outsideWorkspace(step.body.file) && (
            <span className="text-xs text-warm">
              This file is outside the workspace, so Auxin won't send it. Move it into the workspace folder and choose it again.
            </span>
          )}
          {typeof filePreview === "string" && <span className="text-xs text-bad-soft">{filePreview}</span>}
          {filePreview && typeof filePreview === "object" && (
            <div className="overflow-hidden rounded-md border border-line">
              <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs text-fg-3">
                <FileJson className="size-3.5" /> {formatBytes(filePreview.size)}
                {filePreview.size > filePreview.text.length && " · showing the start"}
              </div>
              <pre className="max-h-48 overflow-auto p-3 font-mono text-xs text-fg-2 select-text">{filePreview.text}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CurlExport({ doc, step }: { doc: FlowDoc; step: FlowStep }) {
  const extracted = useFlows((s) => s.extracted[doc.path]);
  const src = varSources(doc, extracted);
  const root = useFlows((s) => s.root);
  const build = (withSecrets: boolean) => {
    const sub = (t: string) => (withSecrets ? resolve(t, src).text : resolveHidingSecrets(t, src));
    const body =
      step.body.kind === "json" || step.body.kind === "text"
        ? sub(step.body.text)
        : step.body.kind === "form"
          ? step.body.form.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(sub(f.value))}`).join("&")
          : step.body.kind === "file" && step.body.file
            ? `@${step.body.file.startsWith("/") ? step.body.file : `${root}/${step.body.file}`}`
            : "";
    return toCurl({ method: step.method, url: sub(step.url), headers: step.headers.filter((h) => h.key.trim()).map((h) => [h.key, sub(h.value)]), body });
  };
  const copy = async (withSecrets: boolean) => {
    await navigator.clipboard?.writeText(build(withSecrets));
    toast(
      "info",
      withSecrets ? "Copied with secrets filled in" : "Copied as curl",
      withSecrets ? "Careful where you paste it." : "Secrets stay as {{placeholders}}.",
    );
  };
  return (
    <div className="grid gap-2">
      <pre className="overflow-x-auto rounded-md border border-line bg-rail p-3 font-mono text-sm text-fg-2 select-text">{build(false)}</pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void copy(false)}>
          <Copy /> Copy as curl
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copy(true)}>
          Copy with secrets
        </Button>
      </div>
    </div>
  );
}

/* ---------------- response ---------------- */

function ResponsePanel({ doc, out, notTaken, onCancel }: { doc: FlowDoc; out?: StepOutcome; notTaken: boolean; onCancel: () => void }) {
  const hasTrace = !!out?.trace || !!out?.tracing;
  const [tab, setTab] = useState<"trace" | "body" | "headers" | "request">("body");
  // Switch to the trace once per response, when it appears; then leave the choice to the user.
  const switchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (hasTrace && out && switchedFor.current !== out.reqId) {
      switchedFor.current = out.reqId;
      setTab("trace");
    }
  }, [hasTrace, out?.reqId]); // eslint-disable-line react-hooks/exhaustive-deps
  const services = useStore(selectServices);
  const runtime = useStore((s) => s.runtime);

  const center = (children: ReactNode) => <div className="grid min-w-0 content-center justify-items-center gap-3 p-8 text-center">{children}</div>;

  if (!out)
    return center(
      <span className="grid justify-items-center gap-2 text-sm text-fg-3">
        <Play className="size-5 text-fg-3/60" />
        Send this request to see the response here.
      </span>,
    );
  if (out.state === "queued") return center(<span className="text-sm text-fg-3">Waiting for the earlier requests…</span>);
  if (out.state === "skipped")
    return center(
      <span className="text-sm text-fg-3">{notTaken ? "Not run: the if block took the other lane." : "Skipped because an earlier request didn't pass."}</span>,
    );
  if ((out.state === "sending" || out.state === "polling") && !out.res)
    return center(
      <>
        <StatusMark status="starting" size={14} className="text-warm" />
        <span className="font-mono text-xs break-all text-fg-3">
          {out.method} {out.url}
        </span>
        {out.state === "polling" && <span className="text-sm text-fg-2">Polling · try {out.tries}</span>}
        <Button size="sm" onClick={onCancel}>
          <Square /> Cancel
        </Button>
      </>,
    );
  if (out.state === "error" || (out.state === "cancelled" && !out.res)) {
    const owner = out.missingService
      ? (services.find((s) => s.name === out.missingService) ??
        services.find((s) => s.id === serviceIdFor(doc.services.find((f) => f.alias === out.missingService)?.ref ?? "")))
      : out.refusedPort
        ? services.find((s) => (runtime[s.id]?.port ?? s.portHint) === out.refusedPort)
        : undefined;
    return center(
      <>
        <span className="max-w-[440px] text-sm text-bad-soft select-text">{out.error}</span>
        {owner && runtime[owner.id]?.status !== "running" && (
          <Button size="sm" variant="primary" onClick={() => void startService(owner.id)}>
            <Play /> Start {owner.name}
          </Button>
        )}
        <span className="font-mono text-xs break-all text-fg-3">
          {out.method} {out.url}
        </span>
      </>,
    );
  }

  const r = out.res!;
  const failedChecks = out.checks.filter((c) => !c.ok);
  const badHop = out.trace?.hops.some((h) => !h.ok);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3 pb-2">
        <span className={cx("rounded px-2 py-0.5 font-mono text-sm font-semibold", r.status < 400 ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad")}>
          {r.status} {r.statusText}
        </span>
        <span className="font-mono text-sm text-fg-2" title={`First byte after ${formatMs(r.firstByteMs)}`}>
          {formatMs(r.totalMs)}
        </span>
        <span className="font-mono text-sm text-fg-3">{formatBytes(r.size)}</span>
        {(out.tries ?? 0) > 1 && <span className="font-mono text-sm text-fg-3">{out.tries} tries</span>}
        {out.retrying && out.state === "sending" ? (
          <span className="font-mono text-sm text-warm">
            retrying · attempt {out.retrying.attempt} of {out.retrying.of}
          </span>
        ) : (
          (out.attempts ?? 1) > 1 && <span className="font-mono text-sm text-fg-3">{out.attempts} attempts</span>
        )}
        <span className="flex-1" />
        {out.state === "polling" && <span className="font-mono text-sm text-warm">polling · try {out.tries}</span>}
        {out.checks.length > 0 && (
          <span className={cx("text-sm", failedChecks.length ? "text-bad-soft" : "text-ok")}>
            {out.checks.length - failedChecks.length}/{out.checks.length} checks
          </span>
        )}
        {r.bodyText != null && (
          <IconButton size="sm" label="Copy response body" onClick={() => void navigator.clipboard?.writeText(r.bodyText!)}>
            <Copy />
          </IconButton>
        )}
      </div>
      {(out.extracted.length > 0 || failedChecks.length > 0) && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
          {out.extracted.map((e) => (
            <span key={e.key} className="max-w-full truncate rounded bg-surface-3 px-1.5 font-mono text-xs text-fg" title={e.value}>
              {`{{${e.key}}}`} = {e.value}
            </span>
          ))}
          {failedChecks.map((c) => (
            <span key={c.label} className="flex items-center gap-1 rounded bg-bad/10 px-1.5 font-mono text-xs text-bad-soft">
              <X className="size-3" /> {c.label} · got {c.got}
            </span>
          ))}
        </div>
      )}
      <Tabs
        tabs={[
          { id: "trace", label: "Trace", count: out.spans?.length || out.trace?.lines.length, dot: badHop },
          { id: "body", label: "Response" },
          { id: "headers", label: "Headers", count: r.headers.length },
          { id: "request", label: "Request" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="h-[340px] overflow-y-auto">
        {tab === "trace" && <TraceView out={out} injected={doc.injectHeaders} />}
        {tab === "body" && <ResponseBody out={out} />}
        {tab === "headers" && <HeaderList rows={r.headers} />}
        {tab === "request" && (
          <div className="grid gap-3 px-4 py-3">
            <div className="font-mono text-sm break-all text-fg select-text">
              <span style={{ color: METHOD_COLOR[out.method] }}>{out.method}</span> {out.url}
            </div>
            <HeaderList rows={out.headers} bare />
          </div>
        )}
      </div>
    </div>
  );
}

const MATCH_HELP = {
  "request-id": "Auxin added this id to the request; services that log or forward it match exactly.",
  value: "A value from the request or response (like a job id) found in other services' logs.",
};

function TraceView({ out, injected }: { out: StepOutcome; injected: boolean }) {
  const [only, setOnly] = useState<string | null>(null);
  const [showNearby, setShowNearby] = useState(false);
  const services = useStore(selectServices);
  const colorOf = (id: string) => SERVICE_COLORS[services.find((s) => s.id === id)?.color ?? 9];
  if (out.tracing || !out.trace)
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-fg-3">
        <span className="grid justify-items-center gap-2">
          <StatusMark status="starting" size={12} className="text-warm" />
          Collecting log lines from your services…
        </span>
      </div>
    );
  const t = out.trace;
  const pick = (ls: TraceLine[]) => (only ? ls.filter((l) => l.service === only) : ls);
  const lines = showNearby ? [...pick(t.lines), ...pick(t.nearby)].sort((a, b) => a.ts - b.ts) : pick(t.lines);
  const t0 = Math.min(out.sentAt, lines[0]?.ts ?? out.sentAt);
  const total = Math.max(1, ...t.hops.map((h) => h.ms));

  return (
    <div>
      {t.hops.length > 0 && (
        <div className="grid gap-1 border-b border-line px-4 py-3">
          {t.hops.map((h, i) => (
            <button
              key={h.service}
              onClick={() => setOnly(only === h.service ? null : h.service)}
              aria-pressed={only === h.service}
              className={cx(
                "grid grid-cols-[minmax(0,170px)_1fr_72px] items-center gap-3 rounded px-1 py-0.5 text-left text-sm transition-colors hover:bg-surface-2",
                only === h.service && "bg-surface-2",
              )}
              title={only === h.service ? "Show every service" : "Show only this service's lines"}
            >
              <span className={cx("flex min-w-0 items-center gap-1.5", h.ok ? "text-fg" : "text-bad-soft")}>
                {i > 0 && <ArrowRight className="size-3 flex-none text-fg-3" aria-hidden />}
                <span className="h-3 w-[3px] flex-none rounded-full" style={{ background: colorOf(h.service) }} aria-hidden />
                <span className="truncate">{h.alias}</span>
              </span>
              <span className="relative h-2 rounded-full bg-surface-3">
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${Math.max(2, (h.ms / total) * 100)}%`, background: h.ok ? colorOf(h.service) : "var(--color-bad)" }}
                />
              </span>
              <span
                className={cx("text-right font-mono text-xs", h.ok ? "text-fg-3" : "text-bad-soft")}
                title={h.approx ? "From the first to the last matching log line (approximate)" : "Measured response time"}
              >
                {h.approx ? "≈" : ""}
                {formatMs(h.ms)}
              </span>
            </button>
          ))}
        </div>
      )}
      {out.spans?.length ? (
        <>
          <div className="flex items-center gap-2 px-4 pt-2.5 pb-1 text-xs text-fg-3">
            <span className="font-semibold tracking-wider uppercase">Spans</span>
            <span>{out.spans.length} from OpenTelemetry · timings are measured</span>
          </div>
          <SpanWaterfall spans={out.spans} traceId={out.traceId} />
          <div className="px-4 pt-2.5 pb-0.5 text-xs font-semibold tracking-wider text-fg-3 uppercase">Log lines</div>
        </>
      ) : null}
      {lines.length ? (
        <div className="py-1.5 font-mono text-sm leading-[18px] select-text">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cx("flex gap-3 px-4", l.level === "error" && "bg-bad/[0.08]", l.level === "warn" && "bg-warm/[0.06]", l.tier === 3 && "opacity-55")}
            >
              <span className="w-16 flex-none text-right text-fg-3/80 tabular-nums" title={formatClock(l.ts)}>
                +{l.ts - t0}ms
              </span>
              <span className="w-28 flex-none truncate font-semibold" style={{ color: colorOf(l.service) }} title={l.alias}>
                {l.alias}
              </span>
              <span
                className={cx(
                  "min-w-0 break-all whitespace-pre-wrap",
                  l.level === "error" ? "text-bad-soft" : l.level === "warn" ? "text-[#e9c98f]" : "text-fg",
                )}
              >
                {highlight(l.text, l.match)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-4 py-4 text-sm text-fg-3">
          No log lines matched this request.{" "}
          {injected
            ? "Services that log the X-Request-ID header, or ids from the request and response, show up here."
            : "Trace headers are off for this flow, so only ids from the request and response can match."}
          {t.nearby.length > 0 && " Try “Show nearby lines”."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-2 text-xs text-fg-3">
        {t.matchedBy.length ? "Matched by" : "Nothing matched"}
        {t.matchedBy.map((m) => (
          <span key={m.label} className="max-w-60 truncate rounded bg-surface-3 px-1.5 font-mono text-fg-2" title={MATCH_HELP[m.kind]}>
            {m.label}
          </span>
        ))}
        <span className="flex-1" />
        {t.nearby.length > 0 && (
          <button className="text-fg-2 hover:text-fg" onClick={() => setShowNearby((v) => !v)} aria-pressed={showNearby}>
            {showNearby ? "Hide" : "Show"} nearby lines ({t.nearby.length})
          </button>
        )}
      </div>
      {t.unavailable.length > 0 && (
        <p className="px-4 pb-3 text-xs text-fg-3">
          Logs not available for {t.unavailable.join(", ")}: start {t.unavailable.length > 1 ? "them" : "it"} from Auxin to trace through{" "}
          {t.unavailable.length > 1 ? "them" : "it"}.
        </p>
      )}
    </div>
  );
}

function highlight(text: string, needle?: string): ReactNode {
  if (!needle) return text;
  const i = text.indexOf(needle);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{needle}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

/** `narrow` gives keys less room, for side panels. */
export function HeaderList({ rows, bare, narrow }: { rows: [string, string][]; bare?: boolean; narrow?: boolean }) {
  return (
    <div className={cx("grid gap-1 font-mono text-sm", !bare && "px-4 py-3")}>
      {rows.map(([k, v], i) => (
        <div key={k + i} className="flex gap-3">
          <span className={cx("flex-none truncate text-fg-3", narrow ? "w-28" : "w-44")} title={k}>
            {k}
          </span>
          <span className="min-w-0 break-all text-fg select-text">{v}</span>
        </div>
      ))}
      {!rows.length && <span className="text-fg-3">No headers.</span>}
    </div>
  );
}

function ResponseBody({ out }: { out: StepOutcome }) {
  const r = out.res!;
  const type = (r.contentType ?? "").toLowerCase();
  const pretty = useMemo(() => {
    if (r.bodyText == null) return null;
    const t = r.bodyText.trim();
    if (type.includes("json") || /^[[{]/.test(t)) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return null;
      }
    }
    return null;
  }, [r.bodyText, type]);

  return (
    <div>
      {r.truncated && (
        <div className="flex items-center gap-2 border-b border-line bg-warm/10 px-4 py-2 text-xs text-fg-2">
          Showing the first 10 MB of {formatBytes(r.size)}.
          {r.fullBodyPath && (
            <button className="underline underline-offset-2 hover:text-fg" onClick={() => void revealItemInDir(r.fullBodyPath!)}>
              Show full response in Finder
            </button>
          )}
        </div>
      )}
      {pretty != null ? (
        <pre className="px-4 py-3 font-mono text-sm leading-[18px] select-text">
          <Json text={pretty} />
        </pre>
      ) : r.bodyText != null ? (
        r.bodyText ? (
          <pre className="px-4 py-3 font-mono text-sm leading-[18px] break-all whitespace-pre-wrap text-fg select-text">{r.bodyText}</pre>
        ) : (
          <p className="px-4 py-3 text-sm text-fg-3">Empty body.</p>
        )
      ) : type.startsWith("image/") && r.bodyBase64 ? (
        <div className="p-4">
          <img src={`data:${type};base64,${r.bodyBase64}`} alt="Response image" className="max-h-72 rounded border border-line" />
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-fg-3">
          Binary response ({r.contentType ?? "unknown type"}, {formatBytes(r.size)}).
        </p>
      )}
    </div>
  );
}
