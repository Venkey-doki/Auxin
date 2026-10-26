// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ writes: [] as [string, string][] }));

vi.mock("../lib/api", () => ({
  api: {
    auxinWrite: vi.fn(async (_root: string, path: string, text: string) => void io.writes.push([path, text])),
    saveConfig: vi.fn(async () => undefined),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { useStore } from "../state/store";
import { EnvPanel } from "./EnvPanel";
import { parseEnv } from "./model";
import { useFlows } from "./store";

let root: Root;
let host: HTMLElement;
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const nameInputs = () => [...host.querySelectorAll<HTMLInputElement>('section input[aria-label="Name"]')];

function mount(envs: Record<string, ReturnType<typeof parseEnv>>, active = "local") {
  useStore.setState({
    config: {
      version: 1,
      activeWorkspaceId: "w",
      workspaces: [{ id: "w", root: "/w", name: "w", overrides: {}, manual: [], hidden: [], groups: [], activeEnv: active }],
    },
    detected: [],
    runtime: {},
  });
  useFlows.setState({ root: "/w", loaded: true, flows: {}, envs, responses: {}, runs: {}, extracted: {}, invalid: {}, broken: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<EnvPanel onClose={() => undefined} />));
}

beforeEach(() => {
  io.writes = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Environment panel", () => {
  it("renders and settles when no environment exists yet", async () => {
    let renders = 0;
    const unsub = useFlows.subscribe(() => renders++);
    mount({});
    await wait(50);
    unsub();
    expect(host.textContent).toContain("Variables");
    expect(renders).toBeLessThan(5);
  });

  it("keeps a freshly added blank row until the user fills it in", async () => {
    mount({ local: { ...parseEnv("local"), vars: { region: "EU" } } });
    const addVar = [...host.querySelectorAll("section")]
      .find((s) => s.textContent?.includes("Variables"))!
      .querySelector<HTMLButtonElement>("button:not([aria-label])")!;
    act(() => addVar.click());
    expect(nameInputs()).toHaveLength(2);
    await wait(450); // past the save debounce
    expect(nameInputs()).toHaveLength(2);
  });

  it("follows outside changes to sections that aren't being edited", async () => {
    mount({ local: parseEnv("local") });
    act(() => useFlows.setState((s) => ({ envs: { ...s.envs, local: { ...s.envs.local, secrets: { token: "from-curl" } } } })));
    await wait(10);
    const secretsSection = [...host.querySelectorAll("section")].find((s) => s.textContent?.includes("Secrets"))!;
    expect([...secretsSection.querySelectorAll<HTMLInputElement>('input[aria-label="Name"]')].map((i) => i.value)).toEqual(["token"]);
  });

  it("switching environments saves the old one first and never carries its rows over", async () => {
    mount({ local: { ...parseEnv("local"), vars: { a: "1" } }, staging: { ...parseEnv("staging"), vars: { b: "2" } } });
    const value = host.querySelector<HTMLInputElement>('section input[aria-label="Value"]')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(value, "changed");
      value.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Switch before the debounce fires.
    act(() => useStore.setState((s) => ({ config: { ...s.config, workspaces: s.config.workspaces.map((w) => ({ ...w, activeEnv: "staging" })) } })));
    await wait(10);
    expect(nameInputs().map((i) => i.value)).toEqual(["b"]);
    const localWrite = io.writes.find(([p]) => p === "env/local.json");
    expect(localWrite && JSON.parse(localWrite[1]).vars).toEqual({ a: "changed" });
    await wait(450);
    expect(io.writes.some(([p, t]) => p === "env/staging.json" && t.includes('"a"'))).toBe(false);
  });
});
