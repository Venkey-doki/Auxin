/** Side panel for the active environment: variables, secrets, service URLs. */
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, cx, IconButton, inputClass, Switch } from "../components/ui";
import { selectServices, useStore } from "../state/store";
import { parseEnv, type Broker, type EnvDoc, type KV, type NetworkRules } from "./model";
import { KVTable } from "./parts";
import { activeEnvName, createEnv, saveEnvIn, servicePorts, setActiveEnv, sliceOf, useFlows } from "./store";

const rows = (o: Record<string, string>): KV[] => Object.entries(o).map(([key, value]) => ({ key, value }));
const obj = (r: KV[]): Record<string, string> => Object.fromEntries(r.filter((x) => x.key.trim()).map((x) => [x.key.trim(), x.value]));

export function EnvPanel({ onClose }: { onClose: () => void }) {
  const envs = useFlows((s) => s.envs);
  useStore((s) => s.config);
  const name = activeEnvName();
  const stored = envs[name];
  // Stable fallback: a fresh object every render would re-sync forever.
  const env = useMemo(() => stored ?? parseEnv(name), [stored, name]);
  const services = useStore(selectServices);
  useStore((s) => s.runtime);
  const defaults = servicePorts();

  // Edit rows locally (blank rows are allowed while typing); save shortly after.
  const [vars, setVars] = useState<KV[]>(() => rows(env.vars));
  const [secrets, setSecrets] = useState<KV[]>(() => rows(env.secrets));
  const [urls, setUrls] = useState<Record<string, string>>(env.baseUrls);
  const [insecure, setInsecure] = useState(env.insecureTls);
  const [allowPrivate, setAllowPrivate] = useState(env.network.allowPrivate);
  const [brokers, setBrokers] = useState<BrokerRow[]>(() => brokerRows(env.brokers));
  /** Allowed hosts as typed, one per line; saved without blank lines. */
  const [hosts, setHosts] = useState(env.network.allowHosts.join("\n"));
  const [adding, setAdding] = useState<string | null>(null);

  type Section = "vars" | "secrets" | "urls" | "insecure" | "network" | "brokers";
  type Edits = Partial<{ vars: KV[]; secrets: KV[]; urls: Record<string, string>; insecure: boolean; network: NetworkRules; brokers: BrokerRow[] }>;
  /** Unsaved edits, by section, for the env named in `pendingFor`. */
  const pendingEdits = useRef<Edits>({});
  const pendingFor = useRef(name);
  /** The workspace those edits belong to: switching workspace must not save them into the next one. */
  const pendingRoot = useRef(useFlows.getState().root);
  const timer = useRef<number | undefined>(undefined);
  /** The doc this panel last saved: its echo from the store must not reset the rows. */
  const lastSaved = useRef<string | null>(null);
  const shownFor = useRef(name);

  /** Writes pending edits on top of the latest stored env they were made for. */
  const flush = () => {
    window.clearTimeout(timer.current);
    const edits = pendingEdits.current;
    if (!Object.keys(edits).length) return;
    pendingEdits.current = {};
    const target = pendingFor.current;
    const root = pendingRoot.current;
    if (!root) return;
    const latest = sliceOf(root)?.envs[target] ?? parseEnv(target);
    const doc: EnvDoc = {
      ...latest,
      ...(edits.vars ? { vars: obj(edits.vars) } : {}),
      ...(edits.secrets ? { secrets: obj(edits.secrets) } : {}),
      ...(edits.urls ? { baseUrls: Object.fromEntries(Object.entries(edits.urls).filter(([, v]) => v.trim())) } : {}),
      ...(edits.insecure !== undefined ? { insecureTls: edits.insecure } : {}),
      ...(edits.network ? { network: edits.network } : {}),
      ...(edits.brokers
        ? { brokers: Object.fromEntries(edits.brokers.filter((b) => b.name.trim()).map((b) => [b.name.trim(), { type: b.type, url: b.url }])) }
        : {}),
    };
    lastSaved.current = JSON.stringify(doc);
    void saveEnvIn(root, doc);
  };

  // Save anything pending when the panel closes.
  useEffect(() => () => flush(), []);

  useEffect(() => {
    const load = (only?: Set<Section>) => {
      if (!only || only.has("vars")) setVars(rows(env.vars));
      if (!only || only.has("secrets")) setSecrets(rows(env.secrets));
      if (!only || only.has("urls")) setUrls(env.baseUrls);
      if (!only || only.has("insecure")) setInsecure(env.insecureTls);
      if (!only || only.has("brokers")) setBrokers(brokerRows(env.brokers));
      if (!only || only.has("network")) {
        setAllowPrivate(env.network.allowPrivate);
        setHosts(env.network.allowHosts.join("\n"));
      }
    };
    if (shownFor.current !== name) {
      // Switching env: finish the old env's save first, then show the new one in full.
      flush();
      shownFor.current = name;
      load();
      return;
    }
    // Our own save coming back from the store: keep the rows as typed (blank rows included).
    if (lastSaved.current === JSON.stringify(env)) return;
    // An outside change (curl import, git pull): refresh sections not being edited.
    const untouched = new Set<Section>(
      (["vars", "secrets", "urls", "insecure", "network", "brokers"] as Section[]).filter((k) => !(k in pendingEdits.current)),
    );
    load(untouched);
  }, [name, env]);

  const persist = (next: Edits) => {
    pendingFor.current = name;
    pendingRoot.current = useFlows.getState().root;
    pendingEdits.current = { ...pendingEdits.current, ...next };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 350);
  };

  return (
    <aside className="flex w-[380px] flex-none flex-col border-l border-line bg-surface" aria-label="Environment">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-line pr-2 pl-4">
        <span className="font-semibold">Environment</span>
        <span className="flex-1" />
        <IconButton label="Close" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-3">
          {Object.keys(envs).map((n) => (
            <button
              key={n}
              onClick={() => setActiveEnv(n)}
              aria-pressed={n === name}
              className={cx(
                "h-7 rounded-md border px-2.5 text-sm transition-colors",
                n === name ? "border-paper bg-paper font-semibold text-ink" : "border-line-strong text-fg-2 hover:bg-surface-3",
              )}
            >
              {n}
            </button>
          ))}
          {adding == null ? (
            <Button size="sm" variant="ghost" onClick={() => setAdding("")}>
              <Plus /> New
            </Button>
          ) : (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (adding.trim()) void createEnv(adding).then(() => setAdding(null));
              }}
            >
              <input
                autoFocus
                className="h-7 w-28 rounded-md border border-line-strong bg-rail px-2 text-sm outline-none focus:border-paper/70"
                placeholder="staging"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setAdding(null)}
                aria-label="New environment name"
              />
              <Button size="sm" type="submit" disabled={!adding.trim()}>
                Add
              </Button>
            </form>
          )}
        </div>

        <Section title="Variables" note={`.auxin/env/${name}.json · shared through git`}>
          <KVTable
            rows={vars}
            onChange={(r) => {
              setVars(r);
              persist({ vars: r });
            }}
            keyPh="name"
            valPh="value"
            hint="Use as {{name}} in URLs, headers and bodies."
          />
        </Section>

        <Section title="Secrets" note={`.auxin/env/${name}.secret.json · ignored by git`}>
          <KVTable
            secret
            rows={secrets}
            onChange={(r) => {
              setSecrets(r);
              persist({ secrets: r });
            }}
            keyPh="token"
            valPh="value"
            hint="Tokens and keys. Shown as •••••• in sent requests and copied curl."
          />
        </Section>

        <Section title="Service URLs" note="{{service-name}} resolves to these">
          <div className="overflow-hidden rounded-md border border-line">
            {services.map((s) => {
              const fallback = Object.entries(defaults.portToService).find(([, n]) => n === s.name)?.[0];
              return (
                <div key={s.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] divide-x divide-line border-b border-line last:border-b-0">
                  <span className="truncate px-2.5 py-2 font-mono text-xs text-fg-2" title={s.name}>
                    {s.name}
                  </span>
                  <input
                    className="h-8 w-full bg-transparent px-2.5 font-mono text-xs text-fg outline-none placeholder:text-fg-3 focus:bg-rail"
                    value={urls[s.name] ?? ""}
                    placeholder={fallback ? `http://localhost:${fallback}` : "port unknown: start it or set a URL"}
                    onChange={(e) => {
                      const next = { ...urls, [s.name]: e.target.value };
                      setUrls(next);
                      persist({ urls: next });
                    }}
                    aria-label={`URL for ${s.name}`}
                    spellCheck={false}
                  />
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Brokers" note="for publish and wait-for-message steps">
          <div className="grid gap-2">
            {brokers.map((b, i) => {
              const set = (p: Partial<BrokerRow>) => {
                const next = brokers.map((x, j) => (j === i ? { ...x, ...p } : x));
                setBrokers(next);
                persist({ brokers: next });
              };
              return (
                <div key={i} className="group grid gap-1.5 rounded-md border border-line p-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      className={cx(inputClass, "h-7 min-w-0 flex-1 font-mono text-sm")}
                      value={b.name}
                      placeholder="name, e.g. rabbit"
                      onChange={(e) => set({ name: e.target.value })}
                      aria-label="Broker name"
                      spellCheck={false}
                    />
                    <select
                      className={cx(inputClass.replace("w-full ", ""), "h-7 w-28 flex-none appearance-none text-sm")}
                      value={b.type}
                      onChange={(e) => set({ type: e.target.value as Broker["type"] })}
                      aria-label="Broker type"
                    >
                      <option value="rabbitmq">RabbitMQ</option>
                      <option value="kafka">Kafka</option>
                    </select>
                    <IconButton
                      size="sm"
                      label="Remove broker"
                      onClick={() => {
                        const next = brokers.filter((_, j) => j !== i);
                        setBrokers(next);
                        persist({ brokers: next });
                      }}
                    >
                      <X />
                    </IconButton>
                  </div>
                  <input
                    className={cx(inputClass, "h-7 font-mono text-sm")}
                    value={b.url}
                    placeholder={b.type === "kafka" ? "localhost:9092" : "amqp://guest:{{rabbitPass}}@localhost:5672"}
                    onChange={(e) => set({ url: e.target.value })}
                    aria-label="Broker address"
                    spellCheck={false}
                  />
                </div>
              );
            })}
            <Button
              size="sm"
              variant="ghost"
              className="justify-self-start"
              onClick={() => {
                const next = [...brokers, { name: brokers.length ? "" : "rabbit", type: "rabbitmq" as const, url: "amqp://guest:guest@localhost:5672" }];
                setBrokers(next);
                persist({ brokers: next });
              }}
            >
              <Plus /> Add broker
            </Button>
            <span className="text-xs text-fg-3">
              Put passwords in a secret and write {"{{name}}"} in the address. The network rules below apply to brokers too.
            </span>
          </div>
        </Section>

        <Section title="Network">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-sm text-fg-2">Allow localhost and private addresses</span>
            <Switch
              checked={allowPrivate}
              onChange={() => {
                setAllowPrivate(!allowPrivate);
                persist({ network: { allowPrivate: !allowPrivate, allowHosts: hostList(hosts) } });
              }}
              label="Allow localhost and private addresses"
            />
          </div>
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-2">Allowed public hosts</span>
            <textarea
              className="h-20 w-full resize-none rounded-md border border-line-strong bg-rail px-2.5 py-1.5 font-mono text-sm text-fg outline-none placeholder:text-fg-3 focus:border-paper/70"
              value={hosts}
              placeholder={"api.example.com\n*.staging.example.com"}
              onChange={(e) => {
                setHosts(e.target.value);
                persist({ network: { allowPrivate, allowHosts: hostList(e.target.value) } });
              }}
              spellCheck={false}
            />
          </label>
          <span className="text-xs text-fg-3">
            One per line; leave empty to allow any public host. Cloud metadata addresses like 169.254.169.254 are always blocked, and every redirect is checked
            too.
          </span>
        </Section>

        <Section title="TLS">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-sm text-fg-2">Accept self-signed certificates</span>
            <Switch
              checked={insecure}
              onChange={() => {
                setInsecure(!insecure);
                persist({ insecure: !insecure });
              }}
              label="Accept self-signed certificates"
            />
          </div>
        </Section>
      </div>
    </aside>
  );
}

interface BrokerRow {
  name: string;
  type: Broker["type"];
  url: string;
}

const brokerRows = (b: Record<string, Broker>): BrokerRow[] => Object.entries(b).map(([name, x]) => ({ name, ...x }));

const hostList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2 border-b border-line px-4 py-4 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-fg">{title}</span>
        {note && <span className="truncate font-mono text-xs text-fg-3">{note}</span>}
      </div>
      {children}
    </section>
  );
}
