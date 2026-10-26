/**
 * Browser-only stand-in for the Rust backend, so the UI can be previewed with
 * `npm run dev` outside Tauri. Never loaded inside the desktop app.
 */
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { DetectedService } from "../lib/types";

const ROOT = "/Users/dev/code";

function svc(name: string, kind: string, framework: string | null, cmd: string, extra: Partial<DetectedService> = {}): DetectedService {
  const path = `${ROOT}/${name}`;
  return {
    id: path,
    name,
    path,
    kind,
    framework,
    suggestions: [{ label: cmd, command: cmd, source: kind === "node" ? "package.json" : "main_local.py" }],
    defaultCommand: cmd,
    venv: null,
    portHint: null,
    ...extra,
  };
}

const SERVICES: DetectedService[] = [
  svc("api-gateway", "node", "Express", "npm run dev"),
  svc("auth-service", "node", "NestJS", "npm run start:dev"),
  svc("billing-worker", "python", "FastAPI", "python main_local.py", { venv: `${ROOT}/billing-worker/.venv`, portHint: 8081 }),
  svc("queue-router", "node", null, "npm run dev"),
  svc("pricing-model", "python", "FastAPI", "make dev", { venv: `${ROOT}/pricing-model/.venv` }),
  svc("db-migrations", "node", "Express", "npm run dev"),
  svc("web-console", "node", "Vite", "npm run dev"),
];

const SCRIPTS: Record<string, { port: number; lines: string[]; crash?: boolean }> = {
  "api-gateway": { port: 4000, lines: ["[nodemon] 3.1.4", "[nodemon] watching path(s): src/**/*", "\u001b[32minfo\u001b[39m: Connected to Redis at 127.0.0.1:6379", "\u001b[32minfo\u001b[39m: Gateway listening on http://localhost:4000"] },
  "auth-service": { port: 3001, lines: ["\u001b[32m[Nest] 48211  - \u001b[39mStarting Nest application...", "\u001b[32m[Nest] 48211  - \u001b[39m\u001b[33m[InstanceLoader]\u001b[39m AuthModule dependencies initialized", "\u001b[32m[Nest] 48211  - \u001b[39mNest application successfully started on port 3001"] },
  "billing-worker": { port: 8081, lines: ["INFO:     Started server process [48302]", "INFO:     Waiting for application startup.", "INFO:     Application startup complete.", "INFO:     Uvicorn running on http://0.0.0.0:8081 (Press CTRL+C to quit)"] },
  "queue-router": { port: 0, crash: true, lines: ["> queue-router@1.4.0 dev", "> nodemon index.js", "Loading routes.json", "Error: connect ECONNREFUSED 127.0.0.1:8000", "    at TCPConnectWrapper.afterConnect [as oncomplete] (node:net:1607:16)"] },
};

const live = new Map<string, number>();
let pid = 48000;

function log(id: string, text: string, stream = "stdout") {
  void emit("auxin://logs", [{ id, stream, text, ts: Date.now() }]);
}

function startFake(id: string, command: string) {
  const name = id.split("/").pop()!;
  const script = SCRIPTS[name] ?? { port: 5000 + (name.length % 9) * 100, lines: [`${name} booting`, `ready on http://localhost:${5000 + (name.length % 9) * 100}`] };
  const p = ++pid;
  live.set(id, p);
  void emit("auxin://status", { id, status: "running", pid: p, code: null, ts: Date.now() });
  log(id, `$ ${command}`, "system");
  script.lines.forEach((l, i) =>
    setTimeout(() => live.get(id) === p && log(id, l, /error|at /i.test(l) ? "stderr" : "stdout"), 300 + i * 450),
  );
  if (script.crash) {
    setTimeout(() => {
      if (live.get(id) !== p) return;
      live.delete(id);
      log(id, "Process exited with code 1", "system");
      void emit("auxin://status", { id, status: "crashed", pid: null, code: 1, ts: Date.now() });
    }, 300 + script.lines.length * 450);
  } else {
    // Chatter, so the follow-tail and merged views have something to show.
    const tick = setInterval(() => {
      if (live.get(id) !== p) return clearInterval(tick);
      const ms = Math.round(Math.random() * 180 + 4);
      log(id, `\u001b[2m${new Date().toISOString()}\u001b[22m GET /health 200 ${ms}ms`);
    }, 1800 + Math.random() * 1500);
  }
}

/** In-memory `.auxin/` folder for the preview. */
const files = new Map<string, string>([
  [
    "flows/checkout-end-to-end.flow.json",
    JSON.stringify(
      {
        version: 1,
        name: "Checkout end to end",
        services: [
          { ref: "api-gateway", alias: "api-gateway" },
          { ref: "auth-service", alias: "auth-service" },
          { ref: "billing-worker", alias: "billing-worker" },
        ],
        directions: [],
        dismissed: [],
        trace: { injectHeaders: true, graceMs: 600 },
        steps: [
          {
            id: "submit",
            name: "Submit job",
            method: "POST",
            url: "{{api-gateway}}/jobs",
            headers: { Authorization: "Bearer {{token}}" },
            body: { json: { region: "{{region}}", hours: 24 } },
            extract: { jobId: "body.jobId" },
            checks: [{ left: "status", op: "==", right: 202 }],
            timeoutMs: 30000,
          },
          {
            id: "wait",
            name: "Wait for the model",
            method: "GET",
            url: "{{auth-service}}/jobs/{{jobId}}",
            headers: {},
            body: null,
            poll: { until: [{ left: "body.status", op: "==", right: "done" }], everyMs: 700, maxTries: 10 },
            checks: [{ left: "body.status", op: "==", right: "done" }],
            timeoutMs: 30000,
          },
          {
            id: "result",
            name: "Fetch the result",
            method: "GET",
            url: "{{billing-worker}}/results/{{jobId}}",
            headers: {},
            body: null,
            checks: [{ left: "body.items", op: "length ==", right: 24 }],
            timeoutMs: 30000,
          },
        ],
      },
      null,
      2,
    ),
  ],
  ["env/local.json", JSON.stringify({ vars: { region: "eu-west" }, baseUrls: {} }, null, 2)],
  ["env/local.secret.json", JSON.stringify({ vars: { token: "dev-preview-token" } }, null, 2)],
]);


/** Answers like a running dev server would; refuses when the service is stopped. */
const polls = new Map<string, number>();
const downstream: Record<string, string[]> = { "api-gateway": ["auth-service"], "auth-service": ["billing-worker"], "billing-worker": [] };

/**
 * Answers like a running dev server: logs the request (with the X-Request-ID it
 * received) and "forwards" it downstream so the trace has hops. Refuses when stopped.
 */
async function fakeHttp(req: { method: string; url: string; headers: [string, string][]; body: { kind: string; value?: string } }) {
  const u = new URL(req.url);
  const port = Number(u.port || 80);
  const name = Object.entries(SCRIPTS).find(([, v]) => v.port === port)?.[0];
  const idOf = (n: string) => [...live.keys()].find((id) => id.endsWith(`/${n}`));
  if (!name || !idOf(name)) throw `Couldn't connect to ${u.hostname}:${port}. Is the service running?`;
  const rid = req.headers.find(([k]) => k.toLowerCase() === "x-request-id")?.[1] ?? "-";
  const jobId = u.pathname.split("/").pop()?.match(/^[0-9a-f]{6}$/) ? u.pathname.split("/").pop()! : "8f2c1e";
  log(idOf(name)!, `${req.method} ${u.pathname} req=${rid}`);
  await new Promise((r) => setTimeout(r, 60));
  for (const next of downstream[name] ?? []) {
    const nid = idOf(next);
    if (nid) log(nid, `handling job ${jobId} for ${name} req=${rid}`);
  }
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));

  let payload: Record<string, unknown> = { ok: true, service: name, method: req.method, path: u.pathname, received: req.body.kind === "text" ? safeJson(req.body.value!) : null, jobId };
  if (u.pathname.startsWith("/jobs/")) {
    const n = (polls.get(rid.slice(0, 8) + u.pathname) ?? 0) + 1;
    polls.set(rid.slice(0, 8) + u.pathname, n);
    const tries = [...polls.entries()].filter(([k]) => k.endsWith(u.pathname)).reduce((a, [, v]) => a + v, 0);
    payload = { jobId, status: tries >= 2 ? "done" : "running" };
    if (tries >= 2) log(idOf(name)!, `job ${jobId} finished`);
  } else if (u.pathname.startsWith("/results/")) {
    payload = { jobId, items: Array.from({ length: 24 }, (_, h) => ({ hour: h, qty: 1 + (h % 3) })) };
  }
  const body = JSON.stringify(payload);
  return {
    status: req.method === "POST" ? 202 : 200,
    statusText: req.method === "POST" ? "Accepted" : "OK",
    headers: [["content-type", "application/json"], ["x-powered-by", name]],
    contentType: "application/json",
    bodyText: body,
    bodyBase64: null,
    size: body.length,
    truncated: false,
    fullBodyPath: null,
    firstByteMs: 41,
    totalMs: 140 + Math.round(Math.random() * 60),
  };
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export function installMockBackend() {
  let config: string | null = JSON.stringify({
    version: 1,
    activeWorkspaceId: "w1",
    workspaces: [
      {
        id: "w1",
        root: ROOT,
        name: "code",
        overrides: {},
        manual: [],
        hidden: [],
        groups: [{ id: "g1", name: "Backend core", serviceIds: [`${ROOT}/api-gateway`, `${ROOT}/auth-service`, `${ROOT}/billing-worker`], layout: "columns" }],
        flows: [
          {
            id: "f1",
            name: "Checkout end to end",
            steps: [
              { id: "s1", serviceId: `${ROOT}/auth-service`, wait: { type: "log", pattern: "successfully started" }, timeoutSec: 60 },
              { id: "s2", serviceId: `${ROOT}/api-gateway`, wait: { type: "port", port: 4000 }, timeoutSec: 60 },
              { id: "s3", serviceId: `${ROOT}/billing-worker`, wait: { type: "none" }, timeoutSec: 60 },
              { id: "s4", serviceId: `${ROOT}/queue-router`, wait: { type: "delay", seconds: 2 }, timeoutSec: 60 },
            ],
          },
        ],
      },
    ],
  });

  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, any>;
      switch (cmd) {
        case "auxin_list":
          return [...files.entries()].sort().map(([path, text]) => ({ path, text }));
        case "auxin_write":
          files.set(a.path, a.text);
          return null;
        case "auxin_delete":
          files.delete(a.path);
          return null;
        case "auxin_watch":
          return null;
        case "file_preview":
          return ['{ "region": "eu-west", "hours": 24 }', 34];
        case "http_send":
          return fakeHttp(a.req);
        case "http_cancel":
          return true;
        case "http_drop_jar":
          return null;
        case "auxin_list_dir":
          return [...files.keys()].filter((k) => k.startsWith(a.path + "/")).map((k) => k.slice(a.path.length + 1)).sort();
        case "auxin_read":
          if (!files.has(a.path)) throw `No such file: ${a.path}`;
          return files.get(a.path);
        case "detect_directions":
          return [
            { from: "api-gateway", to: "auth-service", source: "env", evidence: ["api-gateway/.env:4  AUTH_URL=http://localhost:3001"] },
            { from: "auth-service", to: "billing-worker", source: "config", evidence: ['auth-service/config/default.json:12  "billing": "http://localhost:8081"'] },
          ].filter((e) => a.services.some((x: { alias: string }) => x.alias === e.from) && a.services.some((x: { alias: string }) => x.alias === e.to));
        case "sample_connections":
          return [];
        case "load_config":
          return config;
        case "save_config":
          config = a.json;
          return null;
        case "scan_workspace":
          return SERVICES;
        case "inspect_folder":
          return null;
        case "running_services":
          return [...live.entries()];
        case "start_service":
          startFake(a.spec.id, a.spec.command);
          return live.get(a.spec.id);
        case "stop_service": {
          const id = a.id as string;
          void emit("auxin://status", { id, status: "stopping", pid: live.get(id), code: null, ts: Date.now() });
          setTimeout(() => {
            live.delete(id);
            log(id, "Stopped", "system");
            void emit("auxin://status", { id, status: "stopped", pid: null, code: null, ts: Date.now() });
          }, 400);
          return null;
        }
        case "send_input":
          log(a.id, a.text);
          return null;
        case "check_port":
          return [...live.keys()].some((id) => SCRIPTS[id.split("/").pop()!]?.port === a.port);
        case "plugin:dialog|open":
          return ROOT;
        case "plugin:dialog|message":
          return a.buttons?.OkCancelCustom?.[0] ?? "Ok";
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
