import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({ api: {} }));

import type { DetectedService } from "../lib/types";
import { selectServices, serviceForSpan, withOtelEnv } from "./store";

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

describe("a service's own OpenTelemetry settings", () => {
  const detected = (id: string, extra: Partial<DetectedService>): DetectedService =>
    ({ id, name: id, path: `/w/${id}`, kind: "node", framework: null, suggestions: [], defaultCommand: null, venv: null, portHint: null, otel: true, ...extra }) as DetectedService;
  const services = (overrides: Record<string, { otel?: boolean }> = {}) =>
    selectServices({
      detected: [detected("api", {}), detected("billing", { otelEndpoint: true, otelServiceName: "billing-svc" })],
      config: { version: 1, activeWorkspaceId: "w", workspaces: [{ id: "w", overrides, manual: [], hidden: [] }] },
    } as never);

  it("leaves traces off for a service whose .env exports elsewhere, unless switched on", () => {
    expect(services().map((s) => [s.name, s.sendTraces])).toEqual([["api", true], ["billing", false]]);
    expect(services({ billing: { otel: true } })[1].sendTraces).toBe(true);
  });

  it("matches spans by the name the service gives itself", () => {
    const list = services();
    expect(serviceForSpan(list, "Billing-Svc")?.id).toBe("billing");
    expect(serviceForSpan(list, "billing")?.id).toBe("billing");
    expect(serviceForSpan(list, "api")?.id).toBe("api");
    expect(withOtelEnv([], list[1].spanName, 4318)).toContainEqual(["OTEL_SERVICE_NAME", "billing-svc"]);
  });
});
