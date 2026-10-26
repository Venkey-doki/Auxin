import clsx, { type ClassValue } from "clsx";
import { Check, PanelLeftOpen } from "lucide-react";
import { toggleSidebar, useStore } from "../state/store";
import { MOD } from "../lib/util";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export const cx = (...c: ClassValue[]) => clsx(c);

type Variant = "default" | "primary" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
  default: "border-line-strong bg-surface-2 text-fg enabled:hover:bg-surface-3",
  primary: "border-paper bg-paper font-semibold text-ink enabled:hover:bg-paper-hi",
  danger: "border-line-strong bg-surface-2 text-bad-soft enabled:hover:border-bad/40 enabled:hover:bg-bad/10",
  ghost: "border-transparent bg-transparent text-fg-2 enabled:hover:bg-surface-2 enabled:hover:text-fg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }>(
  function Button({ variant = "default", size = "md", className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cx(
          "inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-md border text-sm font-medium transition-colors enabled:active:translate-y-px disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:flex-none",
          size === "sm" ? "h-6 px-2" : "h-7 px-2.5",
          VARIANT[variant],
          className,
        )}
        {...rest}
      />
    );
  },
);

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { size?: "sm" | "md"; label: string; pressed?: boolean }>(
  function IconButton({ size = "md", label, pressed, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        aria-label={label}
        title={rest.title ?? label}
        aria-pressed={pressed}
        className={cx(
          "inline-grid flex-none place-items-center rounded text-fg-2 transition-colors enabled:hover:bg-surface-3 enabled:hover:text-fg disabled:opacity-40",
          size === "sm" ? "size-[22px] [&_svg]:size-[13px]" : "size-[26px] [&_svg]:size-[15px]",
          pressed && "bg-surface-3 text-fg",
          className,
        )}
        {...rest}
      />
    );
  },
);

export function Seg({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-0.5 rounded-md border border-line bg-rail p-0.5">
      {children}
    </div>
  );
}

export function SegButton({ active, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      aria-pressed={active}
      className={cx(
        "inline-flex h-[22px] items-center gap-1.5 rounded px-2 text-sm font-medium transition-colors [&_svg]:size-[13px]",
        active ? "bg-surface-3 text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "text-fg-3 hover:text-fg",
        className,
      )}
      {...rest}
    />
  );
}

export const inputClass =
  "h-8 w-full rounded-md border border-line-strong bg-rail px-2.5 text-base text-fg transition-colors placeholder:text-fg-3 hover:border-[#3d4348] focus:border-paper/70 focus:bg-[#0b0d0e] focus:outline-none";

export const MenuItem = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean; active?: boolean }>(
  function MenuItem({ danger, active, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        data-active={active}
        className={cx(
          "flex min-h-[30px] w-full items-center gap-2 rounded px-2 py-1 text-left text-base hover:bg-surface-3 data-[active=true]:bg-surface-3 [&_svg]:size-3.5 [&_svg]:flex-none",
          danger ? "text-bad-soft" : "text-fg [&_svg]:text-fg-2",
          className,
        )}
        {...rest}
      />
    );
  },
);

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-xs font-semibold tracking-wider text-fg-3 uppercase">{children}</div>;
}

export function MenuSep() {
  return <div className="my-1 h-px bg-line" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface px-1.5 py-px font-mono text-xs font-medium text-fg-3">{children}</kbd>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cx("relative h-[18px] w-[30px] flex-none rounded-full transition-colors", checked ? "bg-ok-ink" : "bg-surface-3")}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 size-3.5 rounded-full transition-transform duration-200 ease-out",
          checked ? "translate-x-3 bg-white" : "bg-fg-2",
        )}
      />
    </button>
  );
}

export function CheckBox({ on }: { on: boolean }) {
  return (
    <span className={cx("grid size-3.5 flex-none place-items-center rounded-[3px] border", on ? "border-paper bg-paper text-ink" : "border-line-strong bg-rail")}>
      {on && <Check className="size-2.5 !text-ink" strokeWidth={3} />}
    </span>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-fg-2">
        {label}
      </label>
      {children}
      {hint && <span className="text-sm text-fg-3">{hint}</span>}
    </div>
  );
}

/** Top bar of every main view; doubles as the window drag region. */
export function TopBar({ children }: { children: ReactNode }) {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  return (
    // With the sidebar hidden, leave room for the window's traffic lights.
    <div data-tauri-drag-region className={cx("flex h-[52px] flex-none items-center gap-3 border-b border-line pr-4", collapsed ? "pl-[84px]" : "pl-5")}>
      {collapsed && (
        <IconButton label={`Show sidebar (${MOD}B)`} onClick={toggleSidebar} className="-ml-1">
          <PanelLeftOpen />
        </IconButton>
      )}
      {children}
    </div>
  );
}
