import { openUrl } from "@tauri-apps/plugin-opener";
import { Maximize2, Minimize2, Play, RotateCw, Square, X } from "lucide-react";
import { useState, type ButtonHTMLAttributes } from "react";
import type { Service } from "../lib/types";
import { formatUptime, SERVICE_COLORS } from "../lib/util";
import { isLive, navigate, restartService, startService, stopService, useStore } from "../state/store";
import { shownStatus, STATUS_INK, STATUS_LABEL, StatusMark, useNow } from "./status";
import { cx } from "./ui";

/** Ink-on-paper button used only inside tickets. */
function TBtn({ go, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { go?: boolean }) {
  return (
    <button
      className={cx(
        "inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded px-1 text-sm font-semibold transition-colors disabled:opacity-40 [&_svg]:size-[13px]",
        go ? "bg-ink px-2 text-paper enabled:hover:bg-black" : "text-ink-2 enabled:hover:bg-paper-line/60 enabled:hover:text-ink",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * The signature: a thermal ticket clipped to the rail. Index, name plate,
 * port, uptime and a stamped state; the service's log hangs beneath it.
 */
export function Ticket({
  service,
  size = "sm",
  onRemove,
  onFocus,
  focused,
}: {
  service: Service;
  size?: "sm" | "lg";
  onRemove?: () => void;
  onFocus?: () => void;
  focused?: boolean;
}) {
  const rt = useStore((s) => s.runtime[service.id]);
  const now = useNow(1000);
  const shown = shownStatus(rt, now);
  const live = isLive(rt);
  const port = rt?.port ?? (live ? undefined : (service.portHint ?? undefined));
  const lg = size === "lg";
  // Stamp only when the state actually changes, never on mount. The stamp remounts
  // per state (key={shown}), so the class only has to be there once it has changed.
  const [mountedAs, setMountedAs] = useState<typeof shown | null>(shown);
  if (mountedAs !== null && mountedAs !== shown) setMountedAs(null);
  const changed = mountedAs === null;

  const meta: string[] = [];
  if (service.framework) meta.push(service.framework);
  else if (service.kind !== "custom") meta.push(service.kind);
  if (live && rt?.startedAt) meta.push(`up ${formatUptime(now - rt.startedAt)}`);
  if (live && rt?.pid) meta.push(`pid ${rt.pid}`);
  if (!live && rt?.code != null && (shown === "crashed" || shown === "exited")) meta.push(`exit ${rt.code}`);

  const stamp = (
    <span
      key={shown}
      className={cx(
        changed && "animate-stamp",
        "stamp inline-flex items-center gap-1.5 rounded-[3px] font-mono font-semibold tracking-[0.08em] uppercase",
        lg ? "px-2 py-0.5 text-sm" : "px-1.5 text-xs leading-[18px]",
        STATUS_INK[shown],
      )}
    >
      <StatusMark status={shown} size={lg ? 9 : 7} />
      {STATUS_LABEL[shown]}
    </span>
  );
  const actions = (
    <div className="flex items-center gap-0.5">
      {live ? (
        <>
          <TBtn onClick={() => void restartService(service.id)} title="Restart" aria-label={`Restart ${service.name}`}>
            <RotateCw />
          </TBtn>
          <TBtn onClick={() => void stopService(service.id)} disabled={rt?.status === "stopping"} title="Stop" aria-label={`Stop ${service.name}`}>
            <Square />
            {lg && "Stop"}
          </TBtn>
        </>
      ) : (
        <TBtn go onClick={() => void startService(service.id)} title="Start" aria-label={`Start ${service.name}`}>
          <Play />
          {lg && "Start"}
        </TBtn>
      )}
      {(onFocus || onRemove) && (
        // In compact lanes these secondary actions appear on hover (or keyboard focus).
        <span className={cx("items-center gap-0.5", lg ? "flex" : "hidden group-hover/ticket:flex group-focus-within/ticket:flex")}>
          {onFocus && (
            <TBtn onClick={onFocus} title={focused ? "Show all" : "Focus this log"} aria-label={focused ? "Show all logs" : `Focus ${service.name}`}>
              {focused ? <Minimize2 /> : <Maximize2 />}
            </TBtn>
          )}
          {onRemove && (
            <TBtn onClick={onRemove} title="Remove from this view" aria-label={`Remove ${service.name} from this view`}>
              <X />
            </TBtn>
          )}
        </span>
      )}
    </div>
  );

  // Group and board lanes: one row, so the log below gets the height.
  if (!lg) {
    const uptime = live && rt?.startedAt ? `up ${formatUptime(now - rt.startedAt)}` : undefined;
    const exit = !live && rt?.code != null && (shown === "crashed" || shown === "exited") ? `exit ${rt.code}` : undefined;
    return (
      <header className="group/ticket on-paper @container relative flex-none">
        <div className="flex h-9 items-center gap-2 bg-paper pr-1.5 pl-2.5 text-ink" title={meta.join(" · ")}>
          <span aria-hidden className="h-4 w-[3px] flex-none rounded-full" style={{ background: SERVICE_COLORS[service.color] }} />
          <span className="hidden flex-none font-mono text-xs font-semibold text-ink-2 tabular-nums @[340px]:inline">
            {String(service.index).padStart(2, "0")}
          </span>
          <button
            className="min-w-0 truncate text-left text-base font-bold tracking-tight hover:underline"
            onClick={() => navigate({ type: "service", id: service.id })}
            title={`Open ${service.name}`}
          >
            {service.name}
          </button>
          {port && (
            <button
              className="flex-none font-mono text-xs font-semibold text-ink underline decoration-paper-line underline-offset-2 hover:decoration-ink"
              onClick={() => void openUrl(`http://localhost:${port}`)}
              title={`Open http://localhost:${port}`}
            >
              :{port}
            </button>
          )}
          {(uptime || exit) && <span className="hidden flex-none font-mono text-xs whitespace-nowrap text-ink-2 @[440px]:inline">{uptime ?? exit}</span>}
          <span className="flex-1" />
          {stamp}
          {actions}
        </div>
      </header>
    );
  }

  return (
    <header className="on-paper relative flex-none">
      <div className={cx("flex items-start gap-3 bg-paper text-ink", lg ? "px-6 pt-5 pb-4" : "px-3 pt-3 pb-2.5")}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              aria-hidden
              className={cx("w-[3px] flex-none self-stretch rounded-full", lg ? "my-1" : "my-0.5")}
              style={{ background: SERVICE_COLORS[service.color] }}
            />
            <span className={cx("flex-none font-mono font-semibold text-ink-2 tabular-nums", lg ? "text-base" : "text-sm")}>
              {String(service.index).padStart(2, "0")}
            </span>
            {lg ? (
              <h1 className="truncate text-2xl leading-tight font-bold tracking-tight">{service.name}</h1>
            ) : (
              <button
                className="truncate text-left text-base font-bold tracking-tight hover:underline"
                onClick={() => navigate({ type: "service", id: service.id })}
                title={`Open ${service.name}`}
              >
                {service.name}
              </button>
            )}
          </div>
          <div className={cx("mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-ink-2", lg ? "text-sm" : "text-xs")}>
            {port && (
              <button
                className="font-semibold text-ink underline decoration-paper-line underline-offset-2 hover:decoration-ink"
                onClick={() => void openUrl(`http://localhost:${port}`)}
                title={`Open http://localhost:${port}`}
              >
                :{port}
              </button>
            )}
            {meta.map((m) => (
              <span key={m} className="whitespace-nowrap">
                {m}
              </span>
            ))}
            {lg && (
              <span className="min-w-0 truncate rounded bg-paper-2 px-1.5 text-ink" title={service.command}>
                $ {service.command || "no command set"}
              </span>
            )}
          </div>
        </div>

        <div className={cx("flex flex-none flex-col items-end", lg ? "gap-3" : "gap-1.5")}>
          {stamp}
          {actions}
        </div>
      </div>
    </header>
  );
}
