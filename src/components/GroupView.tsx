import { Columns3, LayoutGrid, ListTree, Play, Plus, Square, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { GroupLayout } from "../lib/types";
import { activeWorkspace, confirmDeleteGroup, isLive, setGroupLayout, startService, stopAll, updateGroup, useStore } from "../state/store";
import { Board } from "./Board";
import { Popover } from "./Popover";
import { ServicePicker } from "./ServicePicker";
import { Button, IconButton, Seg, SegButton, TopBar } from "./ui";

const LAYOUTS: { id: GroupLayout; label: string; icon: typeof Columns3 }[] = [
  { id: "columns", label: "Columns", icon: Columns3 },
  { id: "grid", label: "Grid", icon: LayoutGrid },
  { id: "merged", label: "Merged", icon: ListTree },
];

export function LayoutSwitch({ value, onChange }: { value: GroupLayout; onChange: (l: GroupLayout) => void }) {
  return (
    <Seg label="Log layout">
      {LAYOUTS.map((l) => (
        <SegButton key={l.id} active={value === l.id} onClick={() => onChange(l.id)} title={`${l.label} layout`}>
          <l.icon aria-hidden /> {l.label}
        </SegButton>
      ))}
    </Seg>
  );
}

export function EditableTitle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      className="h-8 min-w-0 flex-[0_1_340px] rounded-md border border-transparent bg-transparent px-2 -ml-2 text-lg font-semibold tracking-tight hover:border-line focus:border-paper/70 focus:bg-rail focus:outline-none"
      defaultValue={value}
      key={value}
      aria-label="Name"
      spellCheck={false}
      onBlur={(e) => {
        const v = e.target.value.trim();
        if (v && v !== value) onChange(v);
        else e.target.value = value;
      }}
      onKeyDown={(e) => {
        const el = e.target as HTMLInputElement;
        if (e.key === "Enter") el.blur();
        if (e.key === "Escape") {
          el.value = value;
          el.blur();
        }
      }}
    />
  );
}

export function EmptyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="w-full max-w-[460px]">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-2 text-base text-fg-2">{children}</div>
    </div>
  );
}

export function GroupView({ id }: { id: string }) {
  const group = useStore((s) => activeWorkspace(s)?.groups.find((g) => g.id === id));
  const runtime = useStore((s) => s.runtime);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  if (!group) return <div className="grid flex-1 place-items-center text-fg-3">This group was deleted.</div>;
  const anyLive = group.serviceIds.some((sid) => isLive(runtime[sid]));
  const toggle = (sid: string) =>
    updateGroup(group.id, { serviceIds: group.serviceIds.includes(sid) ? group.serviceIds.filter((x) => x !== sid) : [...group.serviceIds, sid] });

  return (
    <>
      <TopBar>
        <EditableTitle value={group.name} onChange={(name) => updateGroup(group.id, { name })} />
        <span className="flex-1" />
        <LayoutSwitch value={group.layout} onChange={(l) => setGroupLayout(group.id, l)} />
        <Button ref={addRef} onClick={() => setAdding((v) => !v)} aria-haspopup="menu" aria-expanded={adding}>
          <Plus /> Services
        </Button>
        {anyLive ? (
          <Button onClick={() => stopAll(group.serviceIds)}>
            <Square /> Stop all
          </Button>
        ) : (
          <Button variant="primary" disabled={!group.serviceIds.length} onClick={() => group.serviceIds.forEach((sid) => void startService(sid))}>
            <Play /> Start all
          </Button>
        )}
        <IconButton label="Delete group" onClick={() => void confirmDeleteGroup(group.id)}>
          <Trash2 />
        </IconButton>
      </TopBar>
      <Popover anchor={addRef} open={adding} onClose={() => setAdding(false)} align="end" width={320}>
        <ServicePicker selected={group.serviceIds} onToggle={toggle} />
      </Popover>

      <Board
        ids={group.serviceIds}
        layout={group.layout}
        onRemove={(sid) => updateGroup(group.id, { serviceIds: group.serviceIds.filter((x) => x !== sid) })}
        empty={
          <EmptyCard title="Put services side by side">
            <p>Pick the services you want to watch together. Each gets its own log column under its ticket, or switch to Merged for one stream.</p>
            <div className="mt-5 rounded-lg border border-line bg-surface p-1.5">
              <ServicePicker selected={group.serviceIds} onToggle={toggle} />
            </div>
          </EmptyCard>
        }
      />
    </>
  );
}
