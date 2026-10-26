/**
 * The project map: every service, the databases, caches, queues and outside
 * APIs they use, and the links between them, each with where it was found.
 * Edits here are shared through `.auxin/topology.json`; flows draw their own
 * maps from the same links.
 */
import {
  ArrowRight,
  Code2,
  Database,
  Globe,
  Inbox,
  LayoutGrid,
  Monitor,
  Plus,
  Radar,
  RotateCcw,
  Server,
  Trash2,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Popover } from "../components/Popover";
import { Button, cx, IconButton, inputClass, MenuLabel, Switch, TopBar } from "../components/ui";
import { slugify } from "../flows/model";
import { useFlows } from "../flows/store";
import { useStore } from "../state/store";
import { EdgePanel, SOURCE_LABEL, toGraphEdge } from "./EdgePanel";
import { autoLayout, GraphCanvas, type GraphNode } from "./GraphCanvas";
import { addNode, edgeKey, keepEdge, kindTo, removeEdge, removeNode, type MapNode, type NodeKind } from "./model";
import { codeScanAllowed, discover, editTopology, setCodeScan, useMap, useTopology } from "./store";

const KIND_LABEL: Record<NodeKind, string> = {
  service: "Service",
  frontend: "Frontend",
  database: "Database",
  cache: "Cache",
  queue: "Queue",
  external: "Outside API",
};
const KIND_ICON: Record<NodeKind, LucideIcon> = { service: Server, frontend: Monitor, database: Database, cache: Zap, queue: Inbox, external: Globe };
const isInfra = (n: MapNode) => n.kind !== "service" && n.kind !== "frontend";

export function MapScreen() {
  const root = useFlows((s) => s.root);
  const runtime = useStore((s) => s.runtime);
  useStore((s) => s.config); // code scan consent lives in the workspace config
  const file = useMap((s) => s.file);
  const discovering = useMap((s) => s.discovering);
  const broken = useMap((s) => s.broken);
  const { nodes, edges } = useTopology();
  const [panel, setPanel] = useState(true);

  const gnodes: GraphNode[] = useMemo(
    () =>
      nodes.map((n) => {
        const port = n.service ? (runtime[n.service.id]?.port ?? n.service.portHint ?? undefined) : undefined;
        const running = !!n.service && runtime[n.service.id]?.status === "running";
        return {
          id: n.key,
          label: n.label,
          sub: n.service
            ? `${port ? `:${port}` : "port unknown"}${n.service.framework ? ` · ${n.service.framework}` : ""}`
            : [n.tech, n.endpoint].filter(Boolean).join(" · ") || KIND_LABEL[n.kind].toLowerCase(),
          kind: n.kind,
          lang: n.service?.kind,
          color: n.service?.color,
          tag: n.service && !running ? { text: "stopped" } : n.manual && !n.service ? { text: "added by you" } : undefined,
          title: n.service ? n.key : `${KIND_LABEL[n.kind]}${n.evidence[0] ? ` · ${SOURCE_LABEL[n.evidence[0].source]}` : ""}`,
          ...file.positions[n.key],
        };
      }),
    [nodes, runtime, file.positions],
  );
  const gedges = edges.map((e) => toGraphEdge(e, (k) => k));
  const infra = nodes.filter(isInfra);
  const removed = file.removed;
  const label = (key: string) => nodes.find((n) => n.key === key)?.label ?? key;

  if (!root) return <div className="grid flex-1 place-items-center text-fg-3">Open a workspace to see its map.</div>;

  return (
    <>
      <TopBar>
        <span className="text-[15px] font-semibold tracking-tight">Map</span>
        <span className="truncate text-sm text-fg-3">
          {nodes.length - infra.length} services · {infra.length} infrastructure · {edges.length} links
          {discovering && " · scanning…"}
        </span>
        <span className="flex-1" />
        <CodeScanToggle />
        <IconButton label="Scan the project again" onClick={() => void discover()} disabled={discovering}>
          <Radar className={discovering ? "animate-pulse" : undefined} />
        </IconButton>
        <IconButton
          label="Auto-arrange"
          onClick={() => {
            const p = autoLayout(gnodes, gedges);
            editTopology((t) => ({ ...t, positions: p }));
          }}
          disabled={!nodes.length}
        >
          <LayoutGrid />
        </IconButton>
        <IconButton label={panel ? "Hide the list" : "Show the list"} pressed={panel} onClick={() => setPanel((v) => !v)}>
          <Server />
        </IconButton>
      </TopBar>

      {broken && (
        <div className="flex flex-none items-center gap-2 border-b border-bad/35 bg-bad/[0.07] px-5 py-2 text-sm" role="alert">
          <TriangleAlert className="size-4 flex-none text-bad-soft" aria-hidden />
          <span className="min-w-0 text-fg-2">
            <span className="font-semibold text-bad-soft">.auxin/topology.json can't be read</span> ({broken}). Often a merge conflict. Your edits aren't saved
            until it's fixed, so the file isn't overwritten.
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <GraphCanvas
            label="Project map"
            nodes={gnodes}
            edges={gedges}
            onMove={(key, x, y) => editTopology((t) => ({ ...t, positions: { ...t.positions, [key]: { x, y } } }))}
            edgePanel={(g, close) => {
              const e = edges.find((x) => edgeKey(x) === edgeKey(g))!;
              return (
                <EdgePanel
                  edge={e}
                  fromLabel={label(e.from)}
                  toLabel={label(e.to)}
                  onKeep={() => editTopology((t) => keepEdge(t, e.from, e.to, e.kind))}
                  onRemove={() => editTopology((t) => removeEdge(t, e.from, e.to))}
                  onClose={close}
                />
              );
            }}
            toolbar={<MapToolbar nodes={nodes} />}
            empty={
              <div className="max-w-[440px] text-center">
                <p className="font-semibold text-fg">{discovering ? "Scanning the project…" : "Nothing on the map yet"}</p>
                <p className="mt-1 text-sm text-fg-3">
                  Services appear once the workspace has them. Databases, caches and queues come from docker-compose, .env, Kubernetes and config files.
                </p>
              </div>
            }
          />
          <Legend />
        </div>
        {panel && (
          <aside className="flex w-[300px] flex-none flex-col border-l border-line bg-surface" aria-label="Infrastructure">
            <div className="flex h-11 flex-none items-center border-b border-line px-4">
              <span className="text-xs font-semibold tracking-wider text-fg-3 uppercase">Infrastructure</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!infra.length && (
                <p className="p-4 text-sm text-fg-3">None found. Add a database, queue or outside API with “Node”, or describe it in docker-compose or .env.</p>
              )}
              {infra.map((n) => {
                const Icon = KIND_ICON[n.kind];
                const links = edges.filter((e) => e.from === n.key || e.to === n.key);
                return (
                  <div key={n.key} className="group grid gap-1 border-b border-line px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon className="size-4 flex-none text-fg-2" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.label}</span>
                      <IconButton
                        size="sm"
                        label={`Remove ${n.label} from the map`}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={() => editTopology((t) => removeNode(t, n.key))}
                      >
                        <Trash2 />
                      </IconButton>
                    </div>
                    <span className="truncate pl-6 font-mono text-xs text-fg-3">{[n.tech, n.endpoint].filter(Boolean).join(" · ") || KIND_LABEL[n.kind]}</span>
                    <span className="truncate pl-6 text-xs text-fg-3">
                      {n.manual ? "Added by you" : [...new Set(n.evidence.map((e) => SOURCE_LABEL[e.source]))].join(", ")}
                      {links.length > 0 && ` · used by ${links.map((e) => label(e.from === n.key ? e.to : e.from)).join(", ")}`}
                    </span>
                  </div>
                );
              })}
              {removed.length > 0 && (
                <div className="grid gap-1 px-4 py-3">
                  <span className="text-xs font-semibold tracking-wider text-fg-3 uppercase">Removed by you</span>
                  {removed.map((k) => (
                    <div key={k} className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">
                        {k.includes("→") ? k.split("→").map(label).join(" → ") : label(k)}
                      </span>
                      <IconButton size="sm" label="Bring back" onClick={() => editTopology((t) => ({ ...t, removed: t.removed.filter((r) => r !== k) }))}>
                        <RotateCcw />
                      </IconButton>
                    </div>
                  ))}
                  <span className="text-xs text-fg-3">Scanning again won't bring these back.</span>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </>
  );
}

/** How links are drawn, in the map's corner. */
function Legend() {
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-3 rounded-md border border-line-strong bg-surface/95 px-2.5 py-1.5 text-xs text-fg-3">
      <span className="flex items-center gap-1.5">
        <svg width="22" height="6" aria-hidden>
          <path d="M1 3h20" stroke="#6b7277" strokeWidth="1.6" />
        </svg>
        declared, seen or kept
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="22" height="6" aria-hidden>
          <path d="M1 3h20" stroke="#6b7277" strokeWidth="1.6" strokeDasharray="4 5" />
        </svg>
        inferred from files
      </span>
    </div>
  );
}

/** Reading source code is off until you allow it, on this machine. */
function CodeScanToggle() {
  const on = codeScanAllowed();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={anchor} size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Code2 /> Code scan {on ? "on" : "off"}
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end" width={320}>
        <div className="grid gap-2 p-2.5">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-sm font-medium">Read source code too</span>
            <Switch checked={on} onChange={() => setCodeScan(!on)} label="Read source code" />
          </div>
          <p className="text-xs text-fg-3">
            Auxin always reads docker-compose, .env, Kubernetes and config files. With this on, it also reads each service's source files for addresses of other
            services. Nothing leaves your machine, and the choice is saved on this machine only, not in the project.
          </p>
        </div>
      </Popover>
    </>
  );
}

/** Add a node nothing mentions (an outside API, a shared database), or a link between two nodes. */
function MapToolbar({ nodes }: { nodes: MapNode[] }) {
  const [menu, setMenu] = useState<"node" | "link" | null>(null);
  const nodeRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLButtonElement>(null);
  const [kind, setKind] = useState<NodeKind>("external");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const f = from || nodes[0]?.key || "";
  const t = to || nodes.find((n) => n.key !== f)?.key || "";
  const key = slugify(name);
  const taken = nodes.some((n) => n.key === key);

  return (
    <>
      <Button ref={nodeRef} size="sm" onClick={() => setMenu(menu === "node" ? null : "node")} aria-expanded={menu === "node"}>
        <Plus /> Node
      </Button>
      <Button ref={linkRef} size="sm" disabled={nodes.length < 2} onClick={() => setMenu(menu === "link" ? null : "link")} aria-expanded={menu === "link"}>
        <ArrowRight /> Link
      </Button>
      <Popover anchor={nodeRef} open={menu === "node"} onClose={() => setMenu(null)} align="end" width={300}>
        <MenuLabel>Add a node</MenuLabel>
        <form
          className="grid gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key || taken) return;
            editTopology((tp) => addNode(tp, { key, kind, label: name.trim(), ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}) }));
            setName("");
            setEndpoint("");
            setMenu(null);
          }}
        >
          <select
            className={cx(inputClass, "h-8 appearance-none text-sm")}
            value={kind}
            onChange={(e) => setKind(e.target.value as NodeKind)}
            aria-label="Kind"
          >
            {(["external", "database", "cache", "queue", "service"] as NodeKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <input
            className={cx(inputClass, "text-sm")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, e.g. Stripe"
            aria-label="Name"
          />
          <input
            className={cx(inputClass, "font-mono text-sm")}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="api.stripe.com (optional)"
            aria-label="Endpoint"
          />
          {taken && <span className="text-xs text-warm">Something on the map already has this name.</span>}
          <Button type="submit" variant="primary" disabled={!key || taken}>
            <Plus /> Add node
          </Button>
        </form>
      </Popover>
      <Popover anchor={linkRef} open={menu === "link"} onClose={() => setMenu(null)} align="end" width={300}>
        <MenuLabel>Add a link</MenuLabel>
        <div className="grid gap-2 p-2">
          <select className={cx(inputClass, "h-8 appearance-none text-sm")} value={f} onChange={(e) => setFrom(e.target.value)} aria-label="From">
            {nodes.map((n) => (
              <option key={n.key} value={n.key}>
                {n.label}
              </option>
            ))}
          </select>
          <div className="flex justify-center text-fg-3">
            <ArrowRight className="size-4 rotate-90" />
          </div>
          <select className={cx(inputClass, "h-8 appearance-none text-sm")} value={t} onChange={(e) => setTo(e.target.value)} aria-label="To">
            {nodes.map((n) => (
              <option key={n.key} value={n.key}>
                {n.label}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            disabled={!f || !t || f === t}
            onClick={() => {
              editTopology((tp) => keepEdge(tp, f, t, kindTo(nodes.find((n) => n.key === t)?.kind)));
              setMenu(null);
            }}
          >
            <Plus /> Add link
          </Button>
        </div>
      </Popover>
    </>
  );
}
