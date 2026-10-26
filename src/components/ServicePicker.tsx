import { useMemo, useState } from "react";
import { SERVICE_COLORS } from "../lib/util";
import { selectServices, useStore } from "../state/store";
import { CheckBox, inputClass, MenuItem } from "./ui";

/** Checklist of workspace services, used to fill groups and flows. */
export function ServicePicker({ selected, onToggle, multi = true }: { selected: string[]; onToggle: (id: string) => void; multi?: boolean }) {
  const services = useStore(selectServices);
  const [q, setQ] = useState("");
  const list = useMemo(() => services.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())), [services, q]);
  return (
    <div className="grid gap-1">
      <input className={inputClass} placeholder="Find a service" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Find a service" />
      <div className="max-h-80 overflow-y-auto">
        {list.map((s) => {
          const on = selected.includes(s.id);
          return (
            <MenuItem key={s.id} onClick={() => onToggle(s.id)} role={multi ? "menuitemcheckbox" : "menuitem"} aria-checked={multi ? on : undefined}>
              {multi && <CheckBox on={on} />}
              <span className="h-3 w-[3px] flex-none rounded-full" style={{ background: SERVICE_COLORS[s.color] }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="flex-none text-sm text-fg-3">{s.framework ?? s.kind}</span>
            </MenuItem>
          );
        })}
        {!list.length && <p className="px-2 py-2 text-sm text-fg-3">No services match.</p>}
      </div>
    </div>
  );
}
