/**
 * An open queue step: where to publish (or listen), the message (or what to
 * wait for), and beside it what was published or received.
 */
import { Inbox, Play, Send, Square, Trash2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { StatusMark } from "../components/status";
import { Button, cx, IconButton, Switch } from "../components/ui";
import type { QueueMessage } from "../lib/api";
import type { FlowDoc, FlowStep, QueueSpec } from "./model";
import { formatBytes, formatMs, Json, KVTable, Tabs, VarInput } from "./parts";
import { cancelStep, sendStep, type StepOutcome } from "./runner";
import { ChecksEditor, HeaderList, inlineInput, OnFailureEditor } from "./StepDetail";
import { activeEnvName, rk, updateStep, useFlows, varSources } from "./store";

type QTab = "body" | "headers" | "match" | "extract" | "failure";

export function QueueDetail({ doc, step, locked, onRemove }: { doc: FlowDoc; step: FlowStep; locked: boolean; onRemove: () => void }) {
  const path = doc.path;
  const out = useFlows((s) => s.responses[rk(path, step.id)]);
  const envs = useFlows((s) => s.envs);
  const extracted = useFlows((s) => s.extracted[path]);
  const src = varSources(doc, extracted);
  const q = step.queue!;
  const publish = step.type === "queue.publish";
  const brokers = envs[activeEnvName()]?.brokers ?? {};
  const broker = brokers[q.broker];
  const kafka = broker?.type === "kafka";
  const [tab, setTab] = useState<QTab>(publish ? "body" : "match");
  const busy = out?.state === "sending";
  const patch = (p: Partial<FlowStep>) => updateStep(path, step.id, p);
  const setQ = (p: Partial<QueueSpec>) => patch({ queue: { ...q, ...p } });
  const field = (value: string, onChange: (v: string) => void, label: string, placeholder: string) => (
    <div className="flex min-w-0 flex-1 items-center rounded-md border border-line-strong bg-rail focus-within:border-paper/70">
      <VarInput value={value} onChange={onChange} src={src} serviceColors={{}} placeholder={placeholder} label={label} onEnter={() => !locked && void sendStep(path, step)} />
    </div>
  );

  return (
    <div className="@container border-t border-line bg-bg">
      <div className="grid grid-cols-1 divide-y divide-line @[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @[860px]:divide-x @[860px]:divide-y-0">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 px-3 pt-3">
            <input
              className="h-7 min-w-0 flex-1 rounded px-1.5 text-base font-semibold outline-none hover:bg-surface-2 focus:bg-rail"
              value={step.name}
              onChange={(e) => patch({ name: e.target.value })}
              aria-label="Step name"
            />
            <IconButton label="Delete step" onClick={onRemove} disabled={locked}>
              <Trash2 />
            </IconButton>
          </div>
          <div className="grid gap-2 p-3">
            <div className="flex items-center gap-2">
              <select
                className={cx(inlineInput, "h-8 w-40 flex-none appearance-none pr-6 text-sm")}
                value={q.broker}
                onChange={(e) => setQ({ broker: e.target.value })}
                aria-label="Broker"
              >
                {!broker && <option value={q.broker}>{q.broker ? `${q.broker} (not in this environment)` : "Choose a broker"}</option>}
                {Object.entries(brokers).map(([name, b]) => (
                  <option key={name} value={name}>
                    {name} · {b.type === "kafka" ? "Kafka" : "RabbitMQ"}
                  </option>
                ))}
              </select>
              {field(q.destination, (destination) => setQ({ destination }), kafka ? "Topic" : "Exchange", kafka ? "topic" : publish ? "exchange (empty: straight to a queue)" : "exchange")}
              {busy ? (
                <Button className="h-8" onClick={() => cancelStep(path, step.id)} disabled={locked}>
                  <Square /> Cancel
                </Button>
              ) : (
                <Button variant="primary" className="h-8" onClick={() => void sendStep(path, step)} disabled={locked || !broker}>
                  {publish ? <Send /> : <Play />} {publish ? "Publish" : "Wait"}
                </Button>
              )}
            </div>
            {!kafka && field(q.routingKey, (routingKey) => setQ({ routingKey }), publish ? "Routing key" : "Binding", publish ? (q.destination ? "routing key" : "queue name") : "binding pattern, # for everything")}
            {kafka && publish && field(q.key, (key) => setQ({ key }), "Message key", "message key (optional)")}
            <p className="text-xs text-fg-3">
              {!Object.keys(brokers).length
                ? "No brokers in this environment yet. Add one under Environment."
                : publish
                  ? kafka
                    ? "Sent to the topic; with a key, to the partition Kafka would pick for it."
                    : q.destination
                      ? "Sent to the exchange with this routing key."
                      : "Sent through the default exchange, straight to the queue named in the routing key."
                  : kafka
                    ? "Reads the topic from the newest message, without a consumer group, so your services' groups aren't touched."
                    : "Listens through its own temporary queue bound to the exchange, so your workers still get every message."}
            </p>
          </div>
          <Tabs
            tabs={
              publish
                ? [
                    { id: "body" as QTab, label: "Message" },
                    { id: "headers" as QTab, label: "Headers", count: q.headers.filter((h) => h.key.trim()).length },
                    { id: "failure" as QTab, label: "If it fails" },
                  ]
                : [
                    { id: "match" as QTab, label: "Match", count: step.checks.filter((c) => c.left.trim()).length + (q.matchRun ? 1 : 0) },
                    { id: "extract" as QTab, label: "Extract", count: step.extract.filter((e) => e.key.trim()).length },
                    { id: "failure" as QTab, label: "If it fails" },
                  ]
            }
            value={tab}
            onChange={setTab}
          />
          <div className="h-[300px] overflow-y-auto p-3">
            {tab === "body" && (
              <textarea
                className="h-full w-full resize-none rounded-md border border-line bg-rail p-3 font-mono text-sm leading-5 text-fg outline-none placeholder:text-fg-3 focus:border-paper/70"
                value={q.body}
                onChange={(e) => setQ({ body: e.target.value })}
                placeholder={'{"orderId": "{{orderId}}"}'}
                spellCheck={false}
                aria-label="Message body"
              />
            )}
            {tab === "headers" && (
              <KVTable
                rows={q.headers}
                onChange={(headers) => setQ({ headers })}
                keyPh="Header"
                valPh="Value · {{variables}} work here"
                hint={doc.injectHeaders ? "Auxin also adds X-Request-ID and traceparent, so a consumer that logs or passes them on can be traced." : undefined}
              />
            )}
            {tab === "match" && (
              <div className="grid gap-4">
                <ChecksEditor
                  checks={step.checks}
                  onChange={(checks) => patch({ checks })}
                  note="Waits for the first message where every condition holds; others are counted and passed over."
                  empty="With no conditions, the first message that arrives counts."
                  first={{ left: "body.status", op: "==", right: "" }}
                />
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-sm text-fg-2">Only messages from this run</span>
                  <Switch checked={q.matchRun} onChange={() => setQ({ matchRun: !q.matchRun })} label="Only messages from this run" />
                </div>
                <span className="-mt-2 text-xs text-fg-3">Needs your services to pass on the traceparent or X-Request-ID header Auxin sends, into the messages they publish.</span>
                <div className="grid gap-1.5">
                  <div className="flex items-center gap-2 text-sm text-fg-2">
                    Wait up to
                    <input
                      className={cx(inlineInput, "h-8 w-20 font-mono text-sm")}
                      type="number"
                      min={1}
                      value={q.timeoutMs / 1000}
                      onChange={(e) => setQ({ timeoutMs: Math.max(1000, Math.round(Number(e.target.value) * 1000) || 15_000) })}
                      aria-label="Seconds to wait"
                    />
                    seconds
                  </div>
                  <span className="text-xs text-fg-3">In a run, listening starts when the run starts, so a message caused by an earlier step is caught.</span>
                </div>
              </div>
            )}
            {tab === "extract" && (
              <KVTable
                rows={step.extract}
                onChange={(extract) => patch({ extract })}
                keyPh="variable, e.g. orderId"
                valPh="body.orderId · header.x-tenant"
                hint="Each value becomes {{variable}} for the steps after this one."
              />
            )}
            {tab === "failure" && <OnFailureEditor step={step} onChange={patch} />}
          </div>
        </div>
        <QueueResult step={step} out={out} onCancel={() => cancelStep(path, step.id)} />
      </div>
    </div>
  );
}

function QueueResult({ step, out, onCancel }: { step: FlowStep; out?: StepOutcome; onCancel: () => void }) {
  const publish = step.type === "queue.publish";
  const center = (children: ReactNode) => <div className="grid min-w-0 content-center justify-items-center gap-3 p-8 text-center">{children}</div>;
  if (!out)
    return center(
      <span className="grid justify-items-center gap-2 text-sm text-fg-3">
        <Inbox className="size-5 text-fg-3/60" />
        {publish ? "Publish to see where the message went." : "Wait for a message to see it here."}
      </span>,
    );
  if (out.state === "queued") return center(<span className="text-sm text-fg-3">Waiting for the earlier steps…</span>);
  if (out.state === "skipped") return center(<span className="text-sm text-fg-3">Not run.</span>);
  if (out.state === "sending")
    return center(
      <>
        <StatusMark status="starting" size={14} className="text-warm" />
        <span className="text-sm text-fg-2">{publish ? "Publishing…" : `Waiting for a message on ${out.url.split(" · ").slice(1).join(" · ")}…`}</span>
        <Button size="sm" onClick={onCancel}>
          <Square /> Cancel
        </Button>
      </>,
    );
  if (out.state === "error" || out.state === "cancelled") return center(<span className="max-w-[440px] text-sm text-bad-soft select-text">{out.error}</span>);
  if (publish && out.published)
    return center(
      <span className="grid justify-items-center gap-1.5">
        <span className="rounded bg-ok/15 px-2 py-0.5 font-mono text-sm font-semibold text-ok">published</span>
        <span className="font-mono text-sm text-fg-2">
          {out.published.destination || "default exchange"} · {formatMs(out.published.ms)}
          {out.published.partition != null && ` · partition ${out.published.partition}`}
          {out.published.offset != null && ` · offset ${out.published.offset}`}
        </span>
      </span>,
    );
  if (!out.message)
    return (
      <div className="grid content-start gap-2 p-4">
        <span className="font-semibold text-bad-soft">No matching message</span>
        {out.checks.map((c) => (
          <span key={c.label} className="font-mono text-xs text-fg-2">
            {c.label}: {c.got}
          </span>
        ))}
      </div>
    );
  return <MessageView out={out} message={out.message} />;
}

function MessageView({ out, message: m }: { out: StepOutcome; message: QueueMessage }) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  const failed = out.checks.filter((c) => !c.ok);
  const pretty = useMemo(() => {
    try {
      return m.bodyText != null ? JSON.stringify(JSON.parse(m.bodyText), null, 2) : null;
    } catch {
      return null;
    }
  }, [m.bodyText]);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3 pb-2">
        <span className={cx("rounded px-2 py-0.5 font-mono text-sm font-semibold", failed.length ? "bg-bad/15 text-bad" : "bg-ok/15 text-ok")}>received</span>
        <span className="font-mono text-sm text-fg-2">
          {m.source}
          {m.routingKey ? ` · ${m.routingKey}` : ""}
          {m.key ? ` · key ${m.key}` : ""}
          {m.partition != null ? ` · p${m.partition}@${m.offset}` : ""}
        </span>
        <span className="font-mono text-sm text-fg-3">{formatBytes(m.size)}</span>
        {(out.seen ?? 0) > 1 && <span className="text-sm text-fg-3">{(out.seen ?? 1) - 1} passed over</span>}
      </div>
      {(out.extracted.length > 0 || failed.length > 0) && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
          {out.extracted.map((e) => (
            <span key={e.key} className="max-w-full truncate rounded bg-surface-3 px-1.5 font-mono text-xs text-fg" title={e.value}>
              {`{{${e.key}}}`} = {e.value}
            </span>
          ))}
          {failed.map((c) => (
            <span key={c.label} className="flex items-center gap-1 rounded bg-bad/10 px-1.5 font-mono text-xs text-bad-soft">
              <X className="size-3" /> {c.label} · got {c.got}
            </span>
          ))}
        </div>
      )}
      <Tabs
        tabs={[
          { id: "body", label: "Message" },
          { id: "headers", label: "Headers", count: m.headers.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="h-[300px] overflow-y-auto">
        {tab === "headers" && <HeaderList rows={m.headers} />}
        {tab === "body" &&
          (pretty != null ? (
            <pre className="px-4 py-3 font-mono text-sm leading-[18px] select-text">
              <Json text={pretty} />
            </pre>
          ) : m.bodyText != null ? (
            <pre className="px-4 py-3 font-mono text-sm leading-[18px] break-all whitespace-pre-wrap text-fg select-text">{m.bodyText || "Empty message."}</pre>
          ) : (
            <p className="px-4 py-3 text-sm text-fg-3">Binary message ({formatBytes(m.size)}).</p>
          ))}
      </div>
    </div>
  );
}
