import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({ api: {} }));

import { withOtelEnv } from "./store";

describe("withOtelEnv", () => {
  it("points the exporter at Auxin, and leaves the service's own settings alone", () => {
    expect(withOtelEnv([["OTEL_SERVICE_NAME", "custom"], ["PORT", "4000"]], "api", 4318)).toEqual([
      ["OTEL_SERVICE_NAME", "custom"],
      ["PORT", "4000"],
      ["OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318"],
      ["OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"],
    ]);
  });

  it("adds nothing when the receiver isn't running", () => {
    expect(withOtelEnv([["A", "1"]], "api", null)).toEqual([["A", "1"]]);
  });
});
