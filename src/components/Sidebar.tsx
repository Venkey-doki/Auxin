import { open } from "@tauri-apps/plugin-dialog";
import { Check, ChevronsUpDown, Eye, PanelLeftClose, FolderOpen, FolderPlus, LayoutPanelLeft, Network, Play, Plus, RefreshCw, Rows3, Search, Square, Trash2, Workflow } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Service } from "../lib/types";
import { MOD, SERVICE_COLORS, shortPath } from "../lib/util";
import {
  activeWorkspace,
  addManualService,
  confirmDeleteGroup,
  createGroup,
  forgetWorkspace,
  isLive,
  navigate,
  openWorkspace,
  hideService,
  rescan,
  selectHiddenServices,
  selectServices,
  setPalette,
  startService,
  stopAll,
  stopService,
  toggleSidebar,
  useStore,
} from "../state/store";
import { allSteps } from "../flows/model";
import { cancelRun, runFlow } from "../flows/runner";
import { confirmDeleteFlow, createFlow, useFlows } from "../flows/store";
import { Popover } from "./Popover";
import { shownStatus, STATUS_LABEL, STATUS_TEXT, StatusMark, useNow } from "./status";
import { Button, cx, IconButton, Kbd, MenuItem, MenuLabel, MenuSep } from "./ui";

export async function pickFolder(title: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

const rowBase = "group relative flex min-h-[30px] items-center rounded-md text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg";
const rowActive = "bg-surface-3 text-fg hover:bg-surface-3";
const mainBtn = "flex min-w-0 flex-1 items-center gap-2.5 py-1 pr-1 pl-2 text-left";

export function Sidebar() {
  const ws = useStore((s) => activeWorkspace(s));
  const services = useStore(selectServices);
  const runtime = useStore((s) => s.runtime);
  const scanning = useStore((s) => s.scanning);
  const view = useStore((s) => s.view);
  const flowMap = useFlows((s) => s.flows);
  const flowRuns = useFlows((s) => s.runs);
  const flows = useMemo(() => Object.values(flowMap).sort((a, b) => a.name.localeCompare(b.name)), [flowMap]);
  const now = useNow(1000);
  const liveCount = useMemo(() => Object.values(runtime).filter(isLive).length, [runtime]);

  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-rail">
      {/* Left padding clears the window's traffic lights. */}
      <div data-tauri-drag-region className="flex h-[52px] flex-none items-center gap-2 pr-1.5 pl-[84px]">
        <span data-tauri-drag-region className="flex-1 font-mono text-sm font-semibold tracking-[0.2em] text-fg-3 uppercase">
          auxin
        </span>
        <IconButton label={`Collapse sidebar (${MOD}B)`} onClick={toggleSidebar}>
          <PanelLeftClose />
        </IconButton>
      </div>

      <div className="flex flex-none flex-col gap-2 px-3 pb-3">
        <WorkspaceSwitcher />
        <button
          onClick={() => setPalette(true)}
          className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2.5 text-base text-fg-3 transition-colors hover:border-line-strong hover:text-fg-2"
        >
          <Search className="size-3.5" aria-hidden />
          <span className="flex-1 text-left">Jump to…</span>
          <Kbd>{MOD}K</Kbd>
        </button>
      </div>

      <nav aria-label="Workspace" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <div className={cx(rowBase, view.type === "overview" && rowActive)}>
          <button className={mainBtn} onClick={() => navigate({ type: "overview" })}>
            <LayoutPanelLeft className="size-4 flex-none text-fg-3" aria-hidden />
            <span className="flex-1 truncate font-medium">Running now</span>
            {liveCount > 0 && <span className="pr-1.5 font-mono text-sm text-ok tabular-nums">{liveCount}</span>}
          </button>
        </div>
        {ws && (
          <div className={cx(rowBase, view.type === "map" && rowActive)}>
            <button className={mainBtn} onClick={() => navigate({ type: "map" })}>
              <Network className="size-4 flex-none text-fg-3" aria-hidden />
              <span className="flex-1 truncate font-medium">Map</span>
            </button>
          </div>
        )}

        {ws && (
          <>
            <SectionHead title="Flows" onAdd={() => void createFlow()} addLabel="New flow" />
            {flows.length === 0 && <Hint onClick={() => void createFlow()}>Chain HTTP requests across your services and see how each one went.</Hint>}
            {flows.map((f) => (
              <div key={f.path} className={cx(rowBase, view.type === "flow" && view.id === f.path && rowActive)}>
                <button className={mainBtn} onClick={() => navigate({ type: "flow", id: f.path })} title={`.auxin/${f.path}`}>
                  <Workflow className={cx("size-4 flex-none", flowRuns[f.path]?.status === "running" ? "text-warm" : flowRuns[f.path]?.status === "failed" ? "text-bad" : flowRuns[f.path]?.status === "passed" ? "text-ok" : "text-fg-3")} aria-hidden />
                  <span className="flex-1 truncate font-medium">{f.name}</span>
                  <span className="pr-1.5 font-mono text-sm text-fg-3 tabular-nums group-hover:hidden">{allSteps(f.steps).length}</span>
                </button>
                <RowAct label={`Delete ${f.name}`} onClick={() => void confirmDeleteFlow(f.path)}>
                  <Trash2 />
                </RowAct>
                {flowRuns[f.path]?.status === "running" ? (
                  <RowAct always label={`Stop ${f.name}`} onClick={() => cancelRun(f.path)}>
                    <Square />
                  </RowAct>
                ) : (
                  <RowAct go always label={`Run ${f.name}`} disabled={!f.steps.length} onClick={() => void runFlow(f.path)}>
                    <Play />
                  </RowAct>
                )}
              </div>
            ))}

            <SectionHead title="Groups" onAdd={() => createGroup()} addLabel="New group" />
            {ws.groups.length === 0 && <Hint onClick={() => createGroup()}>Watch several services' logs side by side.</Hint>}
            {ws.groups.map((g) => (
              <div key={g.id} className={cx(rowBase, view.type === "group" && view.id === g.id && rowActive)}>
                <button className={mainBtn} onClick={() => navigate({ type: "group", id: g.id })}>
                  <Rows3 className="size-4 flex-none text-fg-3" aria-hidden />
                  <span className="flex-1 truncate font-medium">{g.name}</span>
                  <span className="pr-1.5 font-mono text-sm text-fg-3 tabular-nums group-hover:hidden">{g.serviceIds.length}</span>
                </button>
                <RowAct label={`Delete ${g.name}`} onClick={() => void confirmDeleteGroup(g.id)}>
                  <Trash2 />
                </RowAct>
              </div>
            ))}

            <SectionHead
              title="Services"
              extra={
                <IconButton size="sm" label="Rescan folder" onClick={() => void rescan()} disabled={scanning}>
                  <RefreshCw className={scanning ? "animate-spin" : undefined} />
                </IconButton>
              }
              onAdd={async () => {
                const p = await pickFolder("Add a service folder");
                if (p) await addManualService(p);
              }}
              addLabel="Add service folder"
            />
            {services.length === 0 && !scanning && <p className="px-2 py-1 text-sm text-fg-3">No services found in this folder. Add one with +.</p>}
            {services.map((s) => (
              <ServiceRow key={s.id} service={s} now={now} active={view.type === "service" && view.id === s.id} />
            ))}
            <HiddenServices />
          </>
        )}
      </nav>

      {liveCount > 0 && (
        <div className="flex flex-none items-center justify-between border-t border-line px-4 py-2.5">
          <span className="flex items-center gap-2 text-sm text-fg-2">
            <span className="size-1.5 rounded-full bg-ok" aria-hidden />
            {liveCount} running
          </span>
          <Button size="sm" variant="danger" onClick={() => stopAll()}>
            <Square /> Stop all
          </Button>
        </div>
      )}
    </aside>
  );
}

function SectionHead({ title, onAdd, addLabel, extra }: { title: string; onAdd: () => void; addLabel: string; extra?: ReactNode }) {
  return (
    <div className="mt-5 mb-1 flex items-center gap-0.5 pr-1 pl-2">
      <span className="flex-1 text-xs font-semibold tracking-wider text-fg-3 uppercase">{title}</span>
      {extra}
      <IconButton size="sm" label={addLabel} onClick={onAdd}>
        <Plus />
      </IconButton>
    </div>
  );
}

function Hint({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-2">
      {children}
    </button>
  );
}

function RowAct({ go, always, label, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { go?: boolean; always?: boolean; label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "mr-1 grid size-6 flex-none place-items-center rounded transition disabled:!opacity-0 [&_svg]:size-3",
        always ? "opacity-70 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        go ? "text-fg-2 hover:bg-paper hover:text-ink" : "text-fg-2 hover:bg-bad/15 hover:text-bad-soft",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function ServiceRow({ service: s, now, active }: { service: Service; now: number; active: boolean }) {
  const rt = useStore((st) => st.runtime[s.id]);
  const shown = shownStatus(rt, now);
  const live = isLive(rt);
  const line = live ? rt?.lastLine : rt?.status === "crashed" ? (rt.error ?? rt.lastLine) : undefined;
  return (
    <div className={cx(rowBase, active && rowActive)}>
      <button className={cx(mainBtn, "items-start py-1.5")} onClick={() => navigate({ type: "service", id: s.id })} title={`${s.name} — ${STATUS_LABEL[shown]}`}>
        <StatusMark status={shown} className={cx("mt-[4px]", STATUS_TEXT[shown])} />
        <span aria-hidden className="mt-[3px] h-3 w-[3px] flex-none rounded-full" style={{ background: SERVICE_COLORS[s.color] }} />
        <span className="grid min-w-0 flex-1">
          <span className={cx("truncate font-medium", live || active ? "text-fg" : undefined)}>{s.name}</span>
          {line && <span className={cx("truncate font-mono text-xs", shown === "crashed" ? "text-bad-soft/80" : "text-fg-3")}>{line}</span>}
        </span>
      </button>
      {live ? (
        <RowAct always label={`Stop ${s.name}`} onClick={() => void stopService(s.id)}>
          <Square />
        </RowAct>
      ) : (
        <RowAct go always label={s.command ? `Start ${s.name}` : "Set a command first"} onClick={() => void startService(s.id)}>
          <Play />
        </RowAct>
      )}
    </div>
  );
}

function WorkspaceSwitcher() {
  const ws = useStore((s) => activeWorkspace(s));
  const workspaces = useStore((s) => s.config.workspaces);
  const [isOpen, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  const choose = async () => {
    setOpen(false);
    const p = await pickFolder("Open a folder of services");
    if (p) await openWorkspace(p);
  };

  return (
    <>
      <button
        ref={ref}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:border-line-strong"
      >
        <FolderOpen className="size-4 flex-none text-fg-2" aria-hidden />
        <span className="grid min-w-0 flex-1">
          <span className="truncate font-semibold">{ws?.name ?? "No folder"}</span>
          <span className="truncate font-mono text-xs text-fg-3">{ws ? shortPath(ws.root) : "Open a folder to begin"}</span>
        </span>
        <ChevronsUpDown className="size-3.5 flex-none text-fg-3" aria-hidden />
      </button>
      <Popover anchor={ref} open={isOpen} onClose={() => setOpen(false)} width={256}>
        {workspaces.length > 0 && <MenuLabel>Workspaces</MenuLabel>}
        {workspaces.map((w) => (
          <div key={w.id} className="group flex items-center">
            <MenuItem
              onClick={() => {
                setOpen(false);
                void openWorkspace(w.root);
              }}
            >
              <span className="grid w-3.5 flex-none">{w.id === ws?.id && <Check />}</span>
              <span className="grid min-w-0">
                <span className="truncate">{w.name}</span>
                <span className="truncate font-mono text-xs text-fg-3">{shortPath(w.root)}</span>
              </span>
            </MenuItem>
            {w.id !== ws?.id && (
              <IconButton size="sm" label={`Forget ${w.name}`} className="opacity-0 group-hover:opacity-100" onClick={() => forgetWorkspace(w.id)}>
                <Trash2 />
              </IconButton>
            )}
          </div>
        ))}
        {workspaces.length > 0 && <MenuSep />}
        <MenuItem onClick={() => void choose()}>
          <FolderPlus /> Open folder…
        </MenuItem>
      </Popover>
    </>
  );
}

function HiddenServices() {
  // Select stable inputs; deriving a fresh array inside the selector re-renders forever.
  const detected = useStore((s) => s.detected);
  const hiddenIds = useStore((s) => activeWorkspace(s)?.hidden);
  const hidden = useMemo(() => selectHiddenServices({ ...useStore.getState(), detected }), [detected, hiddenIds]);
  const [isOpen, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!hidden.length) return null;
  return (
    <>
      <button ref={ref} onClick={() => setOpen((v) => !v)} className="mt-1 w-full rounded-md px-2 py-1 text-left text-sm text-fg-3 hover:bg-surface-2 hover:text-fg-2">
        {hidden.length} hidden
      </button>
      <Popover anchor={ref} open={isOpen} onClose={() => setOpen(false)} width={260}>
        <MenuLabel>Hidden services</MenuLabel>
        {hidden.map((h) => (
          <MenuItem key={h.id} onClick={() => hideService(h.id, false)}>
            <Eye /> <span className="truncate">Show {h.name}</span>
          </MenuItem>
        ))}
      </Popover>
    </>
  );
}
