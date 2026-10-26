import { FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import type { GroupLayout } from "../lib/types";
import { activeWorkspace, isLive, openWorkspace, selectServices, useStore } from "../state/store";
import { Board } from "./Board";
import { LayoutSwitch } from "./GroupView";
import { pickFolder } from "./Sidebar";
import { Button, Kbd, TopBar } from "./ui";
import { MOD } from "../lib/util";

/**
 * "Running now": only the services that are running at this moment, each as a
 * ticket with its log. Nothing running means an empty rail, said plainly.
 */
export function Overview() {
  const ws = useStore((s) => activeWorkspace(s));
  const runtime = useStore((s) => s.runtime);
  const services = useStore(selectServices);
  const [layout, setLayout] = useState<GroupLayout>("columns");
  const live = useMemo(() => services.filter((s) => isLive(runtime[s.id])).map((s) => s.id), [services, runtime]);

  if (!ws) return <Welcome />;

  return (
    <>
      <TopBar>
        <h1 className="truncate text-lg font-semibold tracking-tight">Running now</h1>
        <span className="truncate text-sm text-fg-3">
          {live.length ? `${live.length} of ${services.length} services running` : `${services.length} services in ${ws.name}`}
        </span>
        <span className="flex-1" />
        {live.length > 1 && <LayoutSwitch value={layout} onChange={setLayout} />}
      </TopBar>
      <Board
        ids={live}
        layout={layout}
        empty={
          <div className="text-center">
            <h2 className="text-xl font-semibold tracking-tight">Nothing is running</h2>
            <p className="mt-1.5 text-base text-fg-3">
              Start a service or a group from the sidebar and it shows up here. <Kbd>{MOD}K</Kbd> jumps to anything.
            </p>
          </div>
        }
      />
    </>
  );
}

function Welcome() {
  const choose = async () => {
    const p = await pickFolder("Open a folder of services");
    if (p) await openWorkspace(p);
  };
  return (
    <>
      <TopBar>
        <span />
      </TopBar>
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-10">
        <div className="w-full max-w-[560px]">
          {/* a blank ticket on the rail, waiting for its first order */}
          <div className="mb-10 bg-rail">
            <div className="rail-bar" aria-hidden />
            <div className="relative bg-paper px-6 pt-5 pb-4 text-ink">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-base font-semibold text-ink-2">00</span>
                <span className="text-2xl font-bold tracking-tight">Your services, on one rail</span>
              </div>
              <p className="mt-1 font-mono text-sm text-ink-2">no more one editor window per service</p>
            </div>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Open the folder that holds your services</h1>
          <p className="mt-2 text-base text-fg-2">
            Auxin looks inside each sub-folder for <code className="font-mono text-fg">package.json</code> scripts, Python entry points and virtualenvs,
            Makefiles, Procfiles, Go, Rust and Java projects, and lists them ready to start. Nothing is changed in your repos.
          </p>
          <Button variant="primary" className="mt-6 h-9 px-4 text-base" onClick={() => void choose()}>
            <FolderOpen /> Open folder…
          </Button>
        </div>
      </div>
    </>
  );
}
