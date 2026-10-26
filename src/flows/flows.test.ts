import { describe, expect, it } from "vitest";
import { parseCurl, toCurl } from "../lib/curl";
import { blankQueueStep, blankStep, isStep, newFlow, parseEnv, parseFlow, serializeEnv, serializeFlow } from "./model";
import { resolve, resolveHidingSecrets, templatize, type VarSources } from "./vars";

const USER_PATCH = `curl --request PATCH \\
  --url http://localhost:4000/api/v1/projects/settings/v2/7d3f2a91-4c6e-4b8a-9f21-5e0c8d4a1b37 \\
  --header 'Authorization: Bearer  \\
  --header 'accept: */*' \\
  --header 'content-type: application/json' \\
  --header 'origin: https://app.example.com' \\
  --data '{"path":"settings.retries","value":3}'`;

describe("curl import", () => {
  it("parses the PATCH pasted with its token removed, and warns", () => {
    const r = parseCurl(USER_PATCH)!;
    expect(r.method).toBe("PATCH");
    expect(r.url).toBe("http://localhost:4000/api/v1/projects/settings/v2/7d3f2a91-4c6e-4b8a-9f21-5e0c8d4a1b37");
    expect(r.headers.map(([k]) => k)).toEqual(["Authorization", "accept", "content-type", "origin"]);
    expect(r.body).toBe('{"path":"settings.retries","value":3}');
    expect(r.warnings).toHaveLength(2);
  });

  it("handles --json, -d implying POST, and HEAD", () => {
    expect(parseCurl(`curl localhost:3001/a --json '{"a":1}'`)).toMatchObject({ method: "POST", url: "http://localhost:3001/a" });
    expect(parseCurl(`curl http://x/y -d 'a=1'`)!.method).toBe("POST");
    expect(parseCurl(`curl -I https://x`)!.method).toBe("HEAD");
    expect(parseCurl("not curl")).toBeNull();
  });

  it("round-trips through toCurl, quotes included", () => {
    const r = parseCurl(toCurl({ method: "PUT", url: "http://a/b", headers: [["X-Q", "it's"]], body: '{"x":"y"}' }))!;
    expect(r).toMatchObject({ method: "PUT", url: "http://a/b", body: '{"x":"y"}' });
    expect(r.headers[0]).toEqual(["X-Q", "it's"]);
  });
});

describe("templatize", () => {
  it("maps a service port to {{service}} and moves the token to a secret", () => {
    const t = templatize({ url: "http://localhost:4000/jobs?x=1", headers: [["Authorization", "Bearer abc.def"]] }, { 4000: "api-gateway" }, {});
    expect(t.url).toBe("{{api-gateway}}/jobs?x=1");
    expect(t.headers).toEqual([["Authorization", "Bearer {{token}}"]]);
    expect(t.newSecrets).toEqual({ token: "abc.def" });
  });

  it("reuses a secret with the same value and avoids clobbering a different one", () => {
    expect(templatize({ url: "http://x", headers: [["authorization", "Bearer same"]] }, {}, { auth: "same" }).headers[0][1]).toBe("Bearer {{auth}}");
    const t = templatize({ url: "http://x", headers: [["Authorization", "Bearer new"]] }, {}, { token: "old" });
    expect(t.newSecrets).toEqual({ token2: "new" });
  });

  it("an empty credential still becomes a placeholder, with nothing stored", () => {
    const t = templatize({ url: "http://localhost:9999/x", headers: [["Authorization", "Bearer"]] }, { 4000: "api" }, {});
    expect(t.url).toBe("http://localhost:9999/x");
    expect(t.headers[0][1]).toBe("Bearer {{token}}");
    expect(t.newSecrets).toEqual({});
  });
});

describe("variables", () => {
  const src: VarSources = {
    secrets: { token: "s3cret" },
    vars: { region: "eu-west", token: "not-this" },
    serviceUrls: { "api-gateway": "http://localhost:4000" },
  };

  it("resolves by precedence and reports what's missing", () => {
    const r = resolve("{{api-gateway}}/jobs/{{region}}?t={{token}}&id={{jobId}}", src);
    expect(r.text).toBe("http://localhost:4000/jobs/eu-west?t=s3cret&id={{jobId}}");
    expect(r.missing).toEqual(["jobId"]);
    expect(r.usedSecrets).toEqual(["token"]);
  });

  it("built-ins resolve and secrets can be kept hidden", () => {
    expect(resolve("{{$uuid}}", src).text).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveHidingSecrets("Bearer {{token}} {{region}}", src)).toBe("Bearer {{token}} eu-west");
  });
});

describe("flow files", () => {
  it("round-trips, preserving fields later phases own", () => {
    const text = JSON.stringify({
      version: 1,
      name: "E2E",
      services: [{ ref: "gw", alias: "gw" }],
      directions: [],
      trace: { injectHeaders: false, graceMs: 900 },
      steps: [
        {
          id: "a",
          name: "Submit",
          method: "post",
          url: "{{gw}}/jobs",
          headers: { "Content-Type": "application/json" },
          body: { json: { n: 1 } },
          extract: { jobId: "body.jobId" },
        },
        { id: "b", name: "File", method: "POST", url: "{{gw}}/x", body: { file: "payloads/a.json" } },
      ],
    });
    const doc = parseFlow("flows/e2e.flow.json", text);
    expect(doc.injectHeaders).toBe(false);
    expect(doc.steps.filter(isStep)[0]).toMatchObject({ method: "POST", body: { kind: "json" }, extract: [{ key: "jobId", value: "body.jobId" }] });
    expect(doc.steps.filter(isStep)[1].body).toMatchObject({ kind: "file", file: "payloads/a.json" });
    const again = JSON.parse(serializeFlow(doc).text);
    expect(again.services).toEqual([{ ref: "gw", alias: "gw" }]);
    expect(again.steps.filter(isStep)[0].extract).toEqual({ jobId: "body.jobId" });
    expect(again.steps[0].http.body).toEqual({ json: { n: 1 } });
    expect(again.trace).toEqual({ injectHeaders: false, graceMs: 900 });
  });

  it("never writes invalid JSON bodies; keeps the last valid one", () => {
    const prev = newFlow("flows/x.flow.json", "X");
    prev.steps = [{ ...blankStep(1), id: "s", body: { kind: "json", text: '{"ok":true}', form: [], file: "" } }];
    const edited = { ...prev, steps: [{ ...prev.steps[0], body: { ...prev.steps.filter(isStep)[0].body, text: '{"ok":' } }] };
    const out = serializeFlow(edited, prev);
    expect(out.invalid).toEqual(["s"]);
    expect(JSON.parse(out.text).steps[0].http.body).toEqual({ json: { ok: true } });
  });

  it("keeps JSON bodies with unquoted {{vars}} as source text", () => {
    const f = newFlow("flows/v.flow.json", "V");
    f.steps = [{ ...blankStep(1), id: "s", body: { kind: "json", text: '{"count": {{n}}}', form: [], file: "" } }];
    const saved = serializeFlow(f).text;
    expect(JSON.parse(saved).steps[0].http.body).toEqual({ jsonText: '{"count": {{n}}}' });
    expect(parseFlow("flows/v.flow.json", saved).steps.filter(isStep)[0].body).toMatchObject({ kind: "json", text: '{"count": {{n}}}' });
  });

  it("empty JSON bodies and long integers survive a save and reload unchanged", () => {
    const f = newFlow("flows/j.flow.json", "J");
    f.steps = [
      { ...blankStep(1), id: "e", body: { kind: "json", text: "", form: [], file: "" } },
      { ...blankStep(2), id: "n", body: { kind: "json", text: '{"id": 1234567890123456789}', form: [], file: "" } },
      { ...blankStep(3), id: "s", body: { kind: "json", text: '{"small": 42, "name": "1234567890123456789"}', form: [], file: "" } },
    ];
    const back = parseFlow("flows/j.flow.json", serializeFlow(f).text);
    expect(back.steps.filter(isStep)[0].body).toMatchObject({ kind: "json", text: "" });
    expect(back.steps.filter(isStep)[1].body.text).toBe('{"id": 1234567890123456789}');
    const mixed = {
      ...f,
      steps: [{ ...blankStep(1), id: "m", body: { kind: "json" as const, text: '{"ref":"1111111111111111","id":12345678901234567890}', form: [], file: "" } }],
    };
    expect(parseFlow("flows/j.flow.json", serializeFlow(mixed).text).steps.filter(isStep)[0].body.text).toContain("12345678901234567890");
    // Long digits inside a string are safe, so it's stored as parsed JSON.
    expect(JSON.parse(serializeFlow(f).text).steps[2].http.body).toEqual({ json: { small: 42, name: "1234567890123456789" } });
  });

  it("loads a version 1 file and saves it as version 2", () => {
    const v1 = JSON.stringify({
      version: 1,
      name: "Old",
      steps: [
        {
          id: "a",
          name: "Wait",
          method: "get",
          url: "{{gw}}/jobs",
          headers: { Accept: "*/*" },
          body: { text: "hi" },
          timeoutMs: 5000,
          poll: { until: { left: "body.done", op: "==", right: true }, everyMs: 200, maxTries: 3 },
          note: "kept",
        },
      ],
    });
    const out = JSON.parse(serializeFlow(parseFlow("flows/old.flow.json", v1)).text);
    expect(out.version).toBe(2);
    expect(out.steps.filter(isStep)[0]).toEqual({
      id: "a",
      type: "http",
      name: "Wait",
      http: { method: "GET", url: "{{gw}}/jobs", headers: { Accept: "*/*" }, body: { text: "hi" }, timeoutMs: 5000 },
      extract: {},
      checks: [],
      wait: { until: [{ left: "body.done", op: "==", right: true }], everyMs: 200, maxTries: 3 },
      note: "kept",
    });
  });

  it("version 2 files round-trip unchanged, without a wait when there's none", () => {
    const f = newFlow("flows/v2.flow.json", "V2");
    f.steps = [{ ...blankStep(1), id: "s", method: "POST", url: "{{gw}}/x", body: { kind: "json", text: '{"a":1}', form: [], file: "" } }];
    const once = serializeFlow(f).text;
    expect(JSON.parse(once).steps.filter(isStep)[0]).not.toHaveProperty("wait");
    expect(JSON.parse(once).steps.filter(isStep)[0]).not.toHaveProperty("method");
    expect(serializeFlow(parseFlow("flows/v2.flow.json", once)).text).toBe(once);
  });

  it("queue steps and brokers round-trip", () => {
    const f = newFlow("flows/q.flow.json", "Q");
    const pub = blankQueueStep("queue.publish", "rabbit");
    const sub = blankQueueStep("queue.consume", "rabbit");
    f.steps = [
      {
        ...pub,
        id: "p",
        queue: {
          ...pub.queue!,
          destination: "orders",
          routingKey: "order.created",
          headers: [{ key: "x-tenant", value: "{{tenant}}" }],
          body: '{"id": {{n}}}',
        },
      },
      {
        ...sub,
        id: "c",
        queue: { ...sub.queue!, destination: "orders", matchRun: true, timeoutMs: 5000 },
        checks: [{ left: "body.status", op: "==", right: '"paid"' }],
      },
    ];
    const text = serializeFlow(f).text;
    const disk = JSON.parse(text);
    expect(disk.steps[0]).toEqual({
      id: "p",
      type: "queue.publish",
      name: "Publish message",
      queue: { broker: "rabbit", destination: "orders", routingKey: "order.created", headers: { "x-tenant": "{{tenant}}" }, body: '{"id": {{n}}}' },
    });
    expect(disk.steps[1].queue).toEqual({ broker: "rabbit", destination: "orders", routingKey: "#", matchRun: true, timeoutMs: 5000 });
    expect(serializeFlow(parseFlow(f.path, text)).text).toBe(text);
    const env = parseEnv(
      "local",
      JSON.stringify({
        vars: {},
        brokers: { rabbit: { type: "rabbitmq", url: "amqp://localhost" }, events: { type: "kafka", url: "localhost:9092" }, bad: { type: "x" } },
      }),
    );
    expect(env.brokers).toEqual({ rabbit: { type: "rabbitmq", url: "amqp://localhost" }, events: { type: "kafka", url: "localhost:9092" } });
    expect(JSON.parse(serializeEnv(env).shared).brokers).toEqual(env.brokers);
  });

  it("environments keep secrets out of the shared file", () => {
    const env = parseEnv("local", '{"vars":{"region":"EU"}}', '{"vars":{"token":"t"}}');
    const { shared, secret } = serializeEnv(env);
    expect(shared).not.toContain('"t"');
    expect(JSON.parse(secret)).toEqual({ vars: { token: "t" } });
  });
});
