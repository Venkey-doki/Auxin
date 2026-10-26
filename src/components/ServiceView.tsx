import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Check, Code2, EyeOff, FolderSearch, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { Service } from "../lib/types";
import { SERVICE_COLORS, shortPath } from "../lib/util";
import { activeWorkspace, hideService, isLive, removeManualService, resetOverride, restartService, selectServices, setOverride, toast, useStore } from "../state/store";
import { LogView } from "./LogView";
import { Ticket } from "./Ticket";
import { Button, cx, Field, IconButton, inputClass, Seg, SegButton, Switch, TopBar } from "./ui";

export function ServiceView({ id }: { id: string }) {
  const service = useStore((s) => selectServices(s).find((x) => x.id === id));
  const [tab, setTab] = useState<"logs" | "settings">("logs");
  const hasCommand = !!service?.command.trim();

  useEffect(() => setTab(hasCommand ? "logs" : "settings"), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!service) return <div className="grid flex-1 place-items-center text-fg-3">This service is no longer in the workspace.</div>;

  return (
    <>
      <TopBar>
        <Seg label="Service sections">
          <SegButton active={tab === "logs"} onClick={() => setTab("logs")}>
            Logs
          </SegButton>
          <SegButton active={tab === "settings"} onClick={() => setTab("settings")}>
            Command & settings
          </SegButton>
        </Seg>
        <span className="flex-1" />
        <span className="truncate font-mono text-sm text-fg-3">{shortPath(service.path)}</span>
        <IconButton label="Open in VS Code" onClick={() => api.openInEditor(service.path).catch((e) => toast("error", "Couldn't open editor", String(e)))}>
          <Code2 />
        </IconButton>
        <IconButton label="Reveal in Finder" onClick={() => void revealItemInDir(service.path)}>
          <FolderSearch />
        </IconButton>
      </TopBar>

      <div className="flex-none bg-rail">
        <div className="rail-bar" aria-hidden />
        <Ticket service={service} size="lg" />
      </div>

      {tab === "logs" ? (
        <div className="min-h-0 flex-1">
          <LogView
            ids={[service.id]}
            inputFor={service.id}
            empty={
              hasCommand ? (
                <span>
                  Press <strong className="text-fg-2">Start</strong> to run <code className="font-mono text-fg-2">{service.command}</code>
                </span>
              ) : (
                <span>
                  No start command yet.{" "}
                  <button className="text-warm underline underline-offset-2" onClick={() => setTab("settings")}>
                    Set one
                  </button>
                </span>
              )
            }
          />
        </div>
      ) : (
        <ServiceSettings service={service} />
      )}
    </>
  );
}

function Block({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("grid gap-4 border-b border-line py-6 last:border-b-0", className)}>{children}</section>;
}

function CommandChips({
  title,
  items,
  current,
  onPick,
  onRemove,
}: {
  title: string;
  items: { command: string; source?: string }[];
  current: string;
  onPick: (c: string) => void;
  onRemove?: (c: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-sm font-semibold text-fg-2">{title}</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => {
          const on = it.command === current;
          return (
            <span
              key={it.command}
              className={cx(
                "inline-flex h-7 items-center rounded-md border font-mono text-sm transition-colors",
                on ? "border-paper bg-paper font-semibold text-ink" : "border-line-strong bg-surface text-fg-2 hover:bg-surface-3 hover:text-fg",
              )}
            >
              <button className="h-full px-2.5" aria-pressed={on} title={it.source ? `From ${it.source}. Click to use.` : "Click to use"} onClick={() => onPick(it.command)}>
                {it.command}
              </button>
              {onRemove && (
                <button
                  className={cx("grid h-full w-6 place-items-center border-l [&_svg]:size-3", on ? "border-paper-line text-ink-2 hover:text-ink" : "border-line-strong hover:text-bad-soft")}
                  onClick={() => onRemove(it.command)}
                  aria-label={`Remove saved command ${it.command}`}
                  title="Remove from saved"
                >
                  <X />
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ServiceSettings({ service }: { service: Service }) {
  const live = useStore((s) => isLive(s.runtime[service.id]));
  const override = useStore((s) => activeWorkspace(s)?.overrides[service.id]);
  const [command, setCommand] = useState(service.command);
  const [dirty, setDirty] = useState(false);

  const [justSaved, setJustSaved] = useState(false);
  const commandDirty = command.trim() !== service.command.trim();

  useEffect(() => setCommand(service.command), [service.id, service.command]);
  useEffect(() => {
    if (!justSaved) return;
    const t = window.setTimeout(() => setJustSaved(false), 4000);
    return () => window.clearTimeout(t);
  }, [justSaved]);

  /** Makes `cmd` the start command and remembers it in the saved list. */
  const saveCommand = (cmd: string) => {
    const c = cmd.trim();
    if (!c) return;
    const detected = service.suggestions.some((sg) => sg.command === c);
    const savedCommands = detected || service.savedCommands.includes(c) ? service.savedCommands : [...service.savedCommands, c];
    setCommand(c);
    commit({ command: c, savedCommands });
    setJustSaved(true);
  };

  const commit = (patch: Parameters<typeof setOverride>[1]) => {
    setOverride(service.id, patch);
    if (live) setDirty(true);
  };
  const env = service.env;
  // Remembered ports and saved commands aren't customisations to reset.
  const customized = !!override && Object.keys(override).some((k) => k !== "lastPort" && k !== "savedCommands");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-8 pb-12">
        {dirty && live && (
          <div className="mt-5 flex items-center gap-3 rounded-md border border-warm/30 bg-warm/10 px-3.5 py-2.5 text-base">
            <span className="flex-1">Changes apply the next time the service starts.</span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setDirty(false);
                void restartService(service.id);
              }}
            >
              <RotateCcw /> Restart now
            </Button>
          </div>
        )}

        <Block>
          <Field label="Start command" htmlFor="cmd" hint="Runs in your login shell from the working folder, so anything that works in your terminal works here.">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveCommand(command);
              }}
            >
              <input
                id="cmd"
                className={cx(inputClass, "font-mono text-sm")}
                value={command}
                placeholder="e.g. npm run dev"
                spellCheck={false}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setCommand(service.command)}
              />
              <Button type="submit" variant="primary" className="h-8" disabled={!commandDirty}>
                <Save /> Save
              </Button>
            </form>
          </Field>
          {commandDirty ? (
            <span className="-mt-2 text-sm text-warm">Unsaved change. Press Save or Enter to keep it, Esc to undo.</span>
          ) : justSaved ? (
            <span className="-mt-2 flex items-center gap-1.5 text-sm text-ok">
              <Check className="size-3.5" /> Saved{live ? ". Restart the service to use it." : ". Start uses this command."}
            </span>
          ) : null}

          {service.savedCommands.length > 0 && (
            <CommandChips
              title="Your saved commands"
              items={service.savedCommands.map((c) => ({ command: c }))}
              current={service.command}
              onPick={(c) => saveCommand(c)}
              onRemove={(c) => commit({ savedCommands: service.savedCommands.filter((x) => x !== c) })}
            />
          )}
          {service.suggestions.length > 0 && (
            <CommandChips
              title="Detected in this folder"
              items={service.suggestions.map((sg) => ({ command: sg.command, source: sg.source }))}
              current={service.command}
              onPick={(c) => saveCommand(c)}
            />
          )}
        </Block>

        <Block className="sm:grid-cols-2">
          <Field label="Display name" htmlFor="name">
            <input
              id="name"
              className={inputClass}
              defaultValue={override?.name ?? ""}
              key={service.id + "name"}
              placeholder={service.path.split("/").pop()}
              onBlur={(e) => commit({ name: e.target.value })}
            />
          </Field>
          <Field label="Working folder" htmlFor="cwd">
            <input
              id="cwd"
              className={cx(inputClass, "font-mono text-sm")}
              defaultValue={override?.cwd ?? ""}
              key={service.id + "cwd"}
              placeholder={shortPath(service.path)}
              spellCheck={false}
              onBlur={(e) => commit({ cwd: e.target.value })}
            />
          </Field>
          <div className="grid gap-2 sm:col-span-2">
            <span className="text-sm font-semibold text-fg-2">Colour in merged logs</span>
            <div className="flex gap-2" role="radiogroup" aria-label="Service colour">
              {SERVICE_COLORS.map((c, i) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={service.color === i}
                  aria-label={`Colour ${i + 1}`}
                  onClick={() => commit({ color: i })}
                  className={cx("size-5 rounded-full transition-transform hover:scale-110", service.color === i && "ring-2 ring-paper ring-offset-2 ring-offset-bg")}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
        </Block>

        {service.venv && (
          <Block className="grid-cols-[1fr_auto] items-center">
            <div className="grid gap-1">
              <span className="text-sm font-semibold text-fg-2">Use Python virtualenv</span>
              <span className="font-mono text-sm text-fg-3">{shortPath(service.venv)}</span>
            </div>
            <Switch checked={service.useVenv} onChange={() => commit({ useVenv: !service.useVenv })} label="Use Python virtualenv" />
          </Block>
        )}

        <Block>
          <div className="grid gap-1">
            <span className="text-sm font-semibold text-fg-2">Environment variables</span>
            <span className="text-sm text-fg-3">Added on top of your shell environment, for this service only.</span>
          </div>
          {env.length > 0 && (
            <div className="grid gap-2">
              {env.map(([k, v], i) => (
                <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2" key={`${i}-${env.length}`}>
                  <input
                    className={cx(inputClass, "font-mono text-sm")}
                    defaultValue={k}
                    placeholder="KEY"
                    spellCheck={false}
                    aria-label="Variable name"
                    onBlur={(e) => commit({ env: env.map((p, j) => (j === i ? [e.target.value, p[1]] : p)) })}
                  />
                  <input
                    className={cx(inputClass, "font-mono text-sm")}
                    defaultValue={v}
                    placeholder="value"
                    spellCheck={false}
                    aria-label="Variable value"
                    onBlur={(e) => commit({ env: env.map((p, j) => (j === i ? [p[0], e.target.value] : p)) })}
                  />
                  <IconButton label="Remove variable" onClick={() => commit({ env: env.filter((_, j) => j !== i) })}>
                    <X />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          <div>
            <Button size="sm" onClick={() => commit({ env: [...env, ["", ""]] })}>
              <Plus /> Add variable
            </Button>
          </div>
        </Block>

        <Block className="flex">
          {customized && (
            <Button size="sm" variant="ghost" onClick={() => resetOverride(service.id)}>
              <RotateCcw /> Reset to detected
            </Button>
          )}
          <span className="flex-1" />
          {service.manual ? (
            <Button size="sm" variant="danger" onClick={() => removeManualService(service.id)}>
              <Trash2 /> Remove service
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => hideService(service.id, true)}>
              <EyeOff /> Hide from list
            </Button>
          )}
        </Block>
      </div>
    </div>
  );
}
