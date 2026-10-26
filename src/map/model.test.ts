import { describe, expect, it } from "vitest";
import type { Service } from "../lib/types";
import {
  addNode,
  edgeKey,
  emptyTopology,
  keepEdge,
  mergeTopology,
  parseTopology,
  removeEdge,
  removeNode,
  serializeTopology,
  type Discovery,
  type Observation,
} from "./model";

const ROOT = "/w";
const svc = (name: string, framework: string | null = null): Service =>
  ({
    id: `${ROOT}/${name}`,
    index: 0,
    name,
    path: `${ROOT}/${name}`,
    kind: "node",
    framework,
    command: "",
    detectedCommand: null,
    suggestions: [],
    savedCommands: [],
    cwd: "",
    env: [],
    venv: null,
    useVenv: false,
    color: 0,
    portHint: null,
    manual: false,
    otel: false,
    otelEndpoint: false,
    spanName: name,
    sendTraces: false,
  }) as Service;
const ev = (source: "compose" | "env", confidence: "declared" | "inferred") => [{ source, confidence, detail: `${source} file` }];
const discovery: Discovery = {
  nodes: [{ key: "postgres", kind: "database", label: "postgres", tech: "postgres", endpoint: "localhost:5432", evidence: ev("compose", "declared") }],
  edges: [
    { from: "api", to: "postgres", kind: "database", evidence: [...ev("compose", "declared"), ...ev("env", "inferred")] },
    { from: "api", to: "worker", kind: "http", evidence: ev("env", "inferred") },
  ],
};
const services = [svc("api"), svc("worker"), svc("web", "vite")];
const merge = (file = emptyTopology(), observed: Observation[] = [], now = Date.parse("2026-10-26T12:00:00Z")) =>
  mergeTopology({ root: ROOT, services, discovery, observed, file, now });
const conf = (r: ReturnType<typeof merge>) => Object.fromEntries(r.edges.map((e) => [edgeKey(e), e.confidence]));

describe("mergeTopology", () => {
  it("puts services and found infrastructure on one map, ranked by the strongest evidence", () => {
    const r = merge();
    expect(r.nodes.map((n) => [n.key, n.kind])).toEqual([
      ["api", "service"],
      ["postgres", "database"],
      ["web", "frontend"],
      ["worker", "service"],
    ]);
    expect(conf(r)).toEqual({ "api→postgres": "declared", "api→worker": "inferred" });
  });

  it("a link you removed stays removed when it's found again, until you add it back", () => {
    const removed = removeEdge(emptyTopology(), "api", "worker");
    expect(conf(merge(removed))).not.toHaveProperty("api→worker");
    expect(conf(merge(keepEdge(removed, "api", "worker", "http")))).toMatchObject({ "api→worker": "manual" });
  });

  it("a removed node takes its links with it; nodes you add stay", () => {
    const t = addNode(removeNode(emptyTopology(), "postgres"), { key: "stripe", kind: "external", label: "Stripe" });
    const r = merge(keepEdge(t, "api", "stripe", "http"));
    expect(r.nodes.map((n) => n.key)).not.toContain("postgres");
    expect(r.edges.map(edgeKey)).toEqual(["api→stripe", "api→worker"]);
    expect(r.nodes.find((n) => n.key === "stripe")).toMatchObject({ manual: true, kind: "external" });
  });

  it("runtime observations raise confidence and fade after a week", () => {
    const seen = (lastSeen: string): Observation[] => [{ from: "worker", to: "api", source: "traffic", detail: "trace", lastSeen }];
    expect(conf(merge(emptyTopology(), seen("2026-10-25T12:00:00Z")))).toMatchObject({ "worker→api": "observed" });
    expect(conf(merge(emptyTopology(), seen("2026-10-01T12:00:00Z")))).not.toHaveProperty("worker→api");
  });

  it("never draws a link to something that isn't on the map", () => {
    const r = mergeTopology({ root: ROOT, services: [svc("api")], discovery, observed: [], file: emptyTopology() });
    expect(r.edges.map(edgeKey)).toEqual(["api→postgres"]);
  });
});

describe("topology.json", () => {
  it("round-trips, sorting removals so diffs stay small", () => {
    const t = removeEdge(removeEdge({ ...emptyTopology(), positions: { api: { x: 1, y: 2 } } }, "b", "a"), "a", "b");
    const text = serializeTopology(t);
    expect(JSON.parse(text).removed).toEqual(["a→b", "b→a"]);
    expect(serializeTopology(parseTopology(text))).toBe(text);
  });

  it("ignores malformed entries instead of failing", () => {
    expect(parseTopology('{"edges":[{"from":"a"}],"removed":[1,"x"],"positions":null}')).toEqual({ ...emptyTopology(), removed: ["x"] });
  });
});
