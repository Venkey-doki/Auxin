import { describe, expect, it } from "vitest";
import type { RunRecord } from "./runner";
import { flowTrends, percentile } from "./trends";

const rec = (n: number, steps: [string, string, number | undefined][], status: RunRecord["status"] = "passed"): RunRecord => ({
  version: 2,
  flow: "F",
  runId: `r${n}`,
  env: "local",
  startedAt: new Date(Date.UTC(2026, 9, 26, 10, n)).toISOString(),
  finishedAt: new Date(Date.UTC(2026, 9, 26, 10, n, 1)).toISOString(),
  status,
  steps: steps.map(([id, state, ms]) => ({
    id,
    name: id.toUpperCase(),
    method: "GET",
    url: "u",
    state: state as never,
    ms,
    checks: [],
    extracted: [],
    hops: [],
  })),
});

describe("trends", () => {
  it("nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(
      percentile(
        [...Array(20).keys()].map((i) => i + 1),
        95,
      ),
    ).toBe(19);
    expect(percentile([5], 95)).toBe(5);
  });

  it("orders points oldest first, counts failures only among runs that sent the request", () => {
    // Newest first, as loadHistory returns them.
    const [whole, a, b] = flowTrends([
      rec(
        3,
        [
          ["a", "passed", 30],
          ["b", "skipped", undefined],
        ],
        "failed",
      ),
      rec(
        2,
        [
          ["a", "failed", 500],
          ["b", "skipped", undefined],
        ],
        "failed",
      ),
      rec(1, [
        ["a", "passed", 10],
        ["b", "passed", 40],
      ]),
    ]);
    expect(whole).toMatchObject({ name: "Whole run", runs: 3, failures: 2, p50: 1000 });
    expect(a.points.map((p) => [p.runId, p.ms, p.failed])).toEqual([
      ["r1", 10, false],
      ["r2", 500, true],
      ["r3", 30, false],
    ]);
    expect(a).toMatchObject({ name: "A", runs: 3, failures: 1, p50: 30, p95: 500 });
    // Skipped runs leave a gap and don't count as runs.
    expect(b).toMatchObject({ runs: 1, failures: 0, p50: 40 });
    expect(b.points.map((p) => p.ms)).toEqual([40, undefined, undefined]);
  });

  it("a request that errored with no response still counts as a failed run", () => {
    const [, a] = flowTrends([rec(1, [["a", "error", undefined]])]);
    expect(a).toMatchObject({ runs: 1, failures: 1, p50: undefined });
  });

  it("a queue step that passed with no time still counts as a run; a cancelled one doesn't", () => {
    const [, q] = flowTrends([rec(3, [["q", "cancelled", undefined]]), rec(2, [["q", "passed", undefined]]), rec(1, [["q", "passed", 12]])]);
    expect(q).toMatchObject({ runs: 2, failures: 0, p50: 12 });
  });

  it("a stopped run leaves a gap in the whole-run trend", () => {
    const [whole] = flowTrends([rec(2, [], "cancelled"), rec(1, [])]);
    expect(whole).toMatchObject({ runs: 1, p50: 1000 });
    expect(whole.points.map((p) => p.ms)).toEqual([1000, undefined]);
  });

  it("no runs, no trends", () => {
    expect(flowTrends([])).toEqual([]);
  });
});
