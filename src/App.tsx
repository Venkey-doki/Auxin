import { CircleAlert, Info, X } from "lucide-react";
import { Component, useEffect, type ReactNode } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { GroupView } from "./components/GroupView";
import { Overview } from "./components/Overview";
import { ServiceView } from "./components/ServiceView";
import { Sidebar } from "./components/Sidebar";
import { IconButton } from "./components/ui";
import { FlowScreen } from "./flows/FlowScreen";
import { MapScreen } from "./map/MapScreen";
import { initFlowsSync } from "./flows/store";
import { boot, dismissToast, navigate, selectServices, setPalette, toggleSidebar, useStore } from "./state/store";

let booted = false;

export default function App() {
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const collapsed = useStore((s) => s.sidebarCollapsed);

  useEffect(() => {
    if (booted) return;
    booted = true;
    void boot().then(() => initFlowsSync());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(!useStore.getState().paletteOpen);
      } else if (mod && /^[1-9]$/.test(e.key)) {
        // Service index doubles as its shortcut.
        const svc = selectServices(useStore.getState()).find((s) => s.index === Number(e.key));
        if (svc) {
          e.preventDefault();
          navigate({ type: "service", id: svc.id });
        }
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key === "0") {
        e.preventDefault();
        navigate({ type: "overview" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="h-full bg-bg" data-tauri-drag-region />;

  return (
    <div className={collapsed ? "grid h-full grid-cols-[minmax(0,1fr)]" : "grid h-full grid-cols-[272px_minmax(0,1fr)]"}>
      {!collapsed && <Sidebar />}
      <main className="flex min-h-0 min-w-0 flex-col">
        <Boundary key={JSON.stringify(view)}>
          {view.type === "overview" && <Overview />}
          {view.type === "service" && <ServiceView key={view.id} id={view.id} />}
          {view.type === "group" && <GroupView id={view.id} />}
          {view.type === "flow" && <FlowScreen path={view.id} />}
          {view.type === "map" && <MapScreen />}
        </Boundary>
      </main>
      <CommandPalette />
      <Toasts />
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="fixed right-4 bottom-4 z-[60] grid w-[340px] gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="flex gap-2.5 rounded-lg border border-line-strong bg-pop py-2.5 pr-2 pl-3 shadow-[0_10px_28px_rgb(0_0_0/0.45)] animate-pop">
          <span className={t.tone === "error" ? "mt-0.5 text-bad" : "mt-0.5 text-fg-2"}>
            {t.tone === "error" ? <CircleAlert className="size-4" /> : <Info className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block font-semibold">{t.title}</strong>
            {t.detail && <p className="mt-0.5 text-sm break-words text-fg-2 select-text">{t.detail}</p>}
          </div>
          <IconButton size="sm" label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

/** Keeps one broken view from blanking the whole window (services keep running). */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid flex-1 place-items-center p-10">
        <div className="max-w-[480px]">
          <h2 className="text-xl font-semibold">This view hit an error</h2>
          <p className="mt-2 font-mono text-sm break-words text-fg-2 select-text">{this.state.error.message}</p>
          <p className="mt-2 text-base text-fg-3">Your services are still running. Pick another item in the sidebar, or reopen this one.</p>
        </div>
      </div>
    );
  }
}
