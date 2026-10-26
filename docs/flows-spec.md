# Flows — implementation spec

Status: **implemented (all phases, 2026-10-24)**; differences from this draft are listed in §13 · 2026-10-24 · design reference: the `?prototype=flows` prototype (`src/prototype/`).

## 1. What a flow is

A flow is an ordered chain of HTTP requests against services in the workspace. Running it sends each request in turn, carries values from one response into the next, checks the results, and **traces** each request through the services' logs. A flow also holds a **service map**: which services it touches, and the direction requests travel between them.

Starting services together is what groups already do. The current "launch set" flows are migrated to groups (§9).

It must work for any project:
- No changes or instrumentation in the services.
- No assumption about language or framework.
- HTTP/1.1 and REST/JSON first. GraphQL works as JSON POST. gRPC and message queues are out of scope (§11).

## 2. Files and storage

| What | Where | In git? |
|---|---|---|
| Flow definitions | `<workspace>/.auxin/flows/<slug>.flow.json` | yes: shareable |
| Environments (non-secret vars) | `<workspace>/.auxin/env/<name>.json` | yes |
| Secrets (tokens, keys) | `<workspace>/.auxin/env/<name>.secret.json` | **no**: Auxin adds `.auxin/env/*.secret.json` and `.auxin/runs/` to `<workspace>/.gitignore` the first time it writes a secret or run |
| Run history (last 30 runs per flow) | `<workspace>/.auxin/runs/<slug>/<timestamp>.json` | no |
| Canvas layout (node positions) | inside the flow file | yes |
| Flow schema (for editors) | `<workspace>/.auxin/schema/flow-2.json` | yes |

- Paths inside flow files are relative to the workspace root, so a teammate's checkout in a different folder works unchanged.
- A service is referred to by its folder path relative to the root (e.g. `api-gateway`). It is never referred to by its absolute path, which is today's internal service id.
- Files are written atomically (temp file, then rename), as `auxin.json` is today.
- Auxin watches `.auxin/flows/` and reloads when a file changes on disk, for example after a `git pull`.

### 2.1 Flow file (`*.flow.json`)

```json
{
  "$schema": "../schema/flow-2.json",
  "version": 2,
  "name": "Checkout end to end",
  "services": [
    { "ref": "api-gateway", "alias": "api-gateway", "x": 0, "y": 0 },
    { "ref": "orders-service", "alias": "orders", "x": 288, "y": 53 }
  ],
  "trace": { "injectHeaders": true, "graceMs": 1500 },
  "steps": [
    {
      "id": "submit",
      "type": "http",
      "name": "Submit job",
      "http": {
        "method": "POST",
        "url": "{{api-gateway}}/jobs",
        "headers": { "Content-Type": "application/json", "Authorization": "Bearer {{token}}" },
        "body": { "file": "fixtures/create-order.json" },
        "timeoutMs": 30000
      },
      "extract": { "jobId": "body.jobId" },
      "checks": [ { "left": "status", "op": "==", "right": 202 } ]
    }
  ]
}
```

- Each step names its kind in `type`; `http` is the only kind so far, and its request sits under `http`. A step that polls has `wait: { until, everyMs, maxTries }`.
- Version 1 files (method, url, headers, body and `poll` directly on the step) still load, and are written as version 2 the next time they're saved.
- `alias` is the short name used in `{{variables}}` and on the canvas. It defaults to the detected service name and can be edited.
- `body` is one of:
  - `{ "json": … }`
  - `{ "text": "…" }`
  - `{ "form": { … } }` (url-encoded)
  - `{ "file": "relative/path" }`: relative to the workspace. A file outside it (absolute path, `..`, or a symlink out) is refused, because flow files can come from someone else's repo. So are files that hold secrets or git data, wherever they are in the workspace: `.env` and `.env.*`, anything under `.git`, `.ssh` or `.auxin/env`, and `*.secret.json`.
  - `null`
- `headers` is an ordered object. Duplicate header names are not supported in v1.
- `$schema` points at `.auxin/schema/flow-2.json`, a JSON Schema Auxin writes into the project when it first saves a flow there (and rewrites when a newer Auxin has a different one; source: `src/flows/flow-2.schema.json`). Editors such as VS Code use it to check and autocomplete flow files offline; nothing is fetched from the internet. Auxin itself ignores `$schema` when reading, so files written by older versions (which named `https://auxin.dev/…`) are updated the next time they're saved.
- Fields this version doesn't know are kept as they are when Auxin saves the file: on the flow, on a step or block, and inside a step's `http`, `http.body`, `wait` and `queue`.
- A step can also have:
  - `retry: { "max": 1–5, "backoffMs": 500, "on": "errors" | "any" }`: re-send after a pause that doubles each time (±20% jitter, capped at 30 s). `errors` covers no response (refused, timed out) and 5xx; `any` also covers failed checks and a poll that never matched.
  - `onFailure: "continue"`: the flow keeps going after this step fails (the run is still marked failed). The default is to stop.

**Blocks.** Besides requests, `steps` can hold two kinds of block. Blocks hold requests only, never other blocks.

```json
{ "id": "b1", "type": "if", "name": "If",
  "when": [ { "left": "status", "op": "==", "right": 404 } ],
  "then": [ /* requests */ ], "else": [ /* requests */ ] }
{ "id": "b2", "type": "parallel", "name": "At the same time",
  "steps": [ /* requests */ ] }
```

- `if` checks `when` (the same rows as checks) on the response of the request just before the block, and runs `then` when every condition holds, `else` otherwise. The lane not taken is marked "not taken".
- `parallel` sends its requests at once, at most 4 in flight. Every request in it is sent even if one fails; the flow then stops (or continues, per `onFailure`) once all have finished. Requests in one parallel block can't use each other's extracted values.

**Queue steps.** A step can publish a message or wait for one, on a broker named in the environment (§2.2):

```json
{ "id": "p", "type": "queue.publish", "name": "Order created",
  "queue": { "broker": "rabbit", "destination": "orders", "routingKey": "order.created",
             "headers": { "x-tenant": "{{tenant}}" }, "body": "{\"orderId\": \"{{orderId}}\"}" } }
{ "id": "c", "type": "queue.consume", "name": "Payment done",
  "queue": { "broker": "rabbit", "destination": "orders", "routingKey": "#", "matchRun": false, "timeoutMs": 15000 },
  "checks": [ { "left": "body.status", "op": "==", "right": "paid" } ],
  "extract": { "paymentId": "body.paymentId" } }
```

- `destination` is a RabbitMQ exchange (`""` is the default exchange: the routing key is then the queue name) or a Kafka topic. RabbitMQ uses `routingKey` (for consume, the binding pattern; `#` takes everything); Kafka publish can set a message `key`.
- Publish adds `X-Request-ID` and `traceparent` headers, like a request.
- **Consume never takes messages from your services.** On RabbitMQ it listens through its own temporary queue bound to the exchange; on Kafka it reads each partition from the newest offset without a consumer group. A message sent straight to a queue (default exchange) can't be watched this way.
- Network rules (§2.2) are checked on the broker address in `url`. Kafka then connects to each partition's leader at the address the cluster advertises, and those addresses aren't checked.
- In a run, every consume step starts listening when the run starts, so a message caused by an earlier step isn't missed. The exception is a consume step whose broker, exchange, topic or binding uses a value extracted by an earlier step: it can only start listening when it's reached, so it can miss a message sent before that. The pre-run strip warns about it. The step then waits up to `timeoutMs` for the first message that passes its `checks` (paths `body…` and `header.<name>`), and can `extract` from it. With `matchRun`, only messages carrying a trace or request id from this run count (the ids are checked on each read, so they include every step that ran before), which needs your services to pass those headers on.
- An if block right after a consume step reads the message it received.

**Checked before a run.** Run refuses to start, and the flow shows a strip of problems, when a request has no URL, a `{{variable}}` has no value or is only extracted later (or by a request sent at the same time), a service's port isn't known yet, or an if block has no condition or no request before it. Variables extracted inside an if lane are a warning, since they may be empty.

### 2.2 Environment and secret files

```json
// .auxin/env/local.json
{ "vars": { "region": "eu-west" }, "baseUrls": { "api-gateway": "http://localhost:4000" } }
// .auxin/env/local.secret.json  (gitignored)
{ "vars": { "token": "eyJhbGciOi…" } }
```

- `baseUrls` is optional. When a service has no entry, `{{alias}}` resolves to `http://localhost:<port>` from the service's detected or announced port (§4.1).
- The environment picker in the top bar lists every file in `.auxin/env/`. `local` is created automatically, but not while an environment file can't be read.
- An environment whose file (or secret file) can't be read, for example after a merge conflict, is never saved over. Edits to it are refused with a message until the file is fixed.
- `brokers: { "rabbit": { "type": "rabbitmq", "url": "amqp://guest:{{rabbitPass}}@localhost:5672" }, "events": { "type": "kafka", "url": "localhost:9092" } }` names the message brokers queue steps use. Put passwords in a secret. The network rules below apply to brokers too.
- `network: { "allowPrivate": true, "allowHosts": ["*.staging.example.com"] }` limits where the environment's requests may go. `allowPrivate` (default on) covers localhost and private addresses; a non-empty `allowHosts` limits public hosts to that list (exact, or `*.` for subdomains). Cloud metadata and link-local addresses are always blocked. The backend checks the resolved address it connects to and every redirect, so a name can't be pointed elsewhere after the check. When an `HTTP(S)_PROXY` environment variable is set, the proxy resolves names; Auxin then also resolves each host (and each redirect's host) itself before sending, so `allowHosts` and `allowPrivate` still hold. A name only the proxy can resolve is allowed only if it's in `allowHosts`. The proxy itself could still connect somewhere else for the same name.

### 2.3 Run history

Each run is saved as a version 2 record: status and timing per request; the request and response headers and bodies, the request as it was sent with its variables filled in (secret values, token-like JSON fields such as `accessToken` or `password`, and values extracted into token-like variables such as `{{accessToken}}` hidden, in the URL too; credential headers hidden; each body cut at 64 KB); the lane each if block took; and a snapshot of the flow as this run sent it. Requests edited while a run is going are sent as edited if they hadn't been sent yet, and the snapshot has them that way. **Replay** in run history runs that snapshot again with the current environment and saves a new record linked to the old one by `replayOf`. Records from before this version have no snapshot and can't be replayed.

**Trends.** Run history opens with a trends table: for the whole run and each request, a sparkline of its time in each saved run (oldest on the left, red dots for failed runs, the latest run highlighted; hover a point for the run's time and date), the median (p50) and 95th percentile (p95), and how many runs failed out of those that sent it. Runs that skipped a request leave a gap. Stopped runs leave a gap in the whole-run row, since their time is when Stop was pressed. It's computed from the saved records; nothing extra is stored.

**Running in another environment.** With more than one environment, the arrow next to *Run flow* runs the flow once in another one without changing the one picked in the top bar. Variables, secrets, service URLs, brokers and network rules all come from that environment; the run summary and its history record name it.

**Switching workspaces.** Each workspace keeps its flows, results, runs and map while you're in another one, and the request you had open in each flow. A run still going when you switch keeps running and saves its history to its own workspace; its log trace and spans are skipped, since the logs and spans on screen belong to the workspace you switched to.

## 3. Variables, extraction, checks, polling

**Resolution order** for `{{name}}`, in URL, headers and body:
1. values extracted earlier in the current run
2. secret vars
3. environment vars
4. service base URLs
5. built-ins: `{{$uuid}}`, `{{$timestamp}}`, `{{$isoDate}}`, `{{$randomInt}}`

An unresolved variable blocks the send with an error that names it. The URL bar shows unknown variables in amber, as in the prototype.

**Path syntax** (used by `extract`, checks and poll):
- `status`, `time` (ms), `header.<name>` (case-insensitive)
- `body` / `body.a.b[0].c`
- `body[*].id` takes the first match

This is a deliberately small JSONPath subset. A non-JSON body is addressable only as `body`, a string.

**Checks:** `left op right`, where `op` is one of:
- `== != < <= > >=`
- `contains`, `matches` (regex)
- `exists`, `!exists`
- `length ==`

`right` is a JSON literal. If any check fails, the step fails and the remaining steps are marked *skipped*, unless the step says `onFailure: "continue"`.

**Poll:** `{ "until": <check or list of checks>, "everyMs": 1000, "maxTries": 30 }`.
- Re-sends until the condition holds.
- Uses the last response.
- After `maxTries`, the step fails with "condition not met after N tries".

**Single-step send:** Send runs one step using the variables extracted by the latest run. It warns if a needed variable has never been extracted.

## 4. Direction detection

> **Superseded (P2):** links between services now live on the project map, not in each flow. See [map.md](map.md). Flow files no longer have `directions` or `dismissed`; an old file's links are handed to `.auxin/topology.json` once on load. The port table (§4.1) and connection sampling (§4.4) still apply; what they and traces observe goes to the map.

Goal: when services are added to a flow, the canvas already shows plausible arrows, each with its evidence. Everything is editable. Nothing is a black box.

### 4.1 Knowing each service's port

Ports are taken from, in order:
1. the port announced in its logs while running (existing `detectPort`)
2. `PORT` in its `.env*` files (existing scanner)
3. `--port`/`-p`/`PORT=` in its start command
4. `port=` in a Python `__main__` block (existing scanner)

This gives a `port → service` table.

### 4.2 Static scan

A new Rust module, `deps.rs`. It runs when services are added to a flow and on Rescan, inside each flow service's folder.

- **Files read:**
  - `.env*` and `docker-compose*.y*ml` `environment:`
  - `config/**`, `*.config.*`, `*routes*.json`, `settings*.py`, `application*.yml|properties`, `appsettings*.json`
  - source files under 512 KB
- **Skipped:** `node_modules`, venvs, `dist`, `build`, `target`, `.git`, binary files.
- **Matched:**
  - URLs whose host is `localhost`, `127.0.0.1`, `0.0.0.0`, `host.docker.internal`, or another service's folder name or alias (docker-compose style), with an explicit port.
  - `*_URL` / `*_HOST` + `*_PORT` env pairs.
- **Edge:** `this → owner of that port`, with `source` = `env` | `config` | `code` and `evidence` = `relative/file:line  KEY=value` (first 3 hits kept).
- **Bounds:** at most 5,000 files and 50 MB read per service. Runs on a background thread, finishes in under a second on typical repos, and is cached per file by modification time.

### 4.3 Traffic

During tracing (§5), if a request id Auxin sent to A shows up in B's logs, that implies A → B. Ordering comes from first-seen time. These edges are added as `source: "traffic"`, `confirmed: false` (dashed), until the user clicks **Keep**.

### 4.4 Connection sampling (phase 4b, optional)

While a flow runs, Auxin runs `lsof -a -p <pid> -iTCP -sTCP:ESTABLISHED -n -P` every 250 ms on each flow service's process group (`netstat`/`Get-NetTCPConnection` on Windows). A connection from A's process to B's port is strong, language-agnostic evidence: `source: "connection"`.

### 4.5 Rules

- Removed edges are remembered in the flow file (`"dismissed": [...]`) so detection never re-adds them.
- Self-edges and edges to services outside the flow are dropped.
- Layout uses left→right layers by direction rank (as the prototype's `autoLayout`) until the user drags a node; after that, positions are saved.

## 5. Tracing

### 5.0 OpenTelemetry spans (when services send them)

Auxin has a built-in OTLP/HTTP trace receiver on `127.0.0.1:4318` (traces only; metrics and logs are accepted and dropped). It takes `application/x-protobuf` and `application/json` bodies only, and refuses any request with an `Origin` header, so a web page in your browser can't post spans to it. If another program already has 4318 (say your own Jaeger or collector), it uses `4319`, and only services Auxin starts reach it.

- **No code change for services that already use an OpenTelemetry SDK.** Auxin detects one from the service's dependencies (`@opentelemetry/*`, `opentelemetry` in Python requirements, `go.opentelemetry.io`, `io.opentelemetry`, .NET `OpenTelemetry`). When it starts such a service it sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` and `OTEL_SERVICE_NAME=<service name>`; variables set on the service in Auxin win. Most `.env` loaders (dotenv, python-dotenv) leave variables that are already set alone, so Auxin's would win over the `.env`. To avoid that, Auxin reads the service's `.env`, `.env.local` and `.env.development`: a service whose file sets `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_TRACES_ENDPOINT`) starts with the switch off, and an `OTEL_SERVICE_NAME` there is passed on unchanged and used to match its spans. A per-service switch (*Send OpenTelemetry traces to Auxin*) turns this on or off; it can also be turned on for a service Auxin didn't detect.
- Each request (and each published message) already carries a `traceparent`, so an instrumented service continues that trace. After the grace period, Auxin asks the receiver for the step's trace **and traces linked to it** (a queue consumer's span links back to the producer's), and shows them as a waterfall under the step. Their hops replace the log-line hops on the map, with measured timings.
- Links the spans prove (a parent span in one service, a child in another; a consumer linked to a producer) go to the project map as *Seen in OpenTelemetry spans*.
- Services without an SDK still show up through log lines (§5.1–5.4), marked approximate. Adding zero-code instrumentation (`NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register`, `opentelemetry-instrument python …`) is a change to the start command you make yourself.
- Not supported: OTLP over gRPC (4317), and services Auxin doesn't start (Docker containers, services started elsewhere), unless they're already configured to export to Auxin's port.

### 5.1 Tagging the request

Every request Auxin sends gets `X-Request-ID: aux-<8 hex>` and a W3C `traceparent` header. Many frameworks log or forward these: Express/Nest middleware, FastAPI/Starlette, Spring, Go chi, OpenTelemetry. Both can be turned off per flow (`trace.injectHeaders`) for services that reject unknown headers.

### 5.2 Collecting lines

Lines come from the existing in-memory buffers (`src/state/logs.ts`, 10,000 lines per service), for every flow service Auxin is running. The **window** runs from send time − 50 ms to response time + `graceMs` (default 1.5 s, which catches async work). For a polling step, the window covers all its tries.

Services not started from Auxin show "logs not available: start it from Auxin to trace it". Tailing external log files is out of scope (§11).

### 5.3 Matching

Each line in the window gets the best of three tiers:

| Tier | Match | Shown as |
|---|---|---|
| 1 | contains the request id or traceparent trace-id | **exact**, highlighted |
| 2 | contains a correlation value (see below) | **value**, highlighted |
| 3 | no match, but in the window and from a flow service | **nearby**, hidden behind "Show nearby lines (N)" |

Correlation values are values ≥ 6 characters taken from:
- the request URL path and query,
- the request body and response body: UUIDs, hex/base62 ids, integers with ≥ 5 digits, and every `extract` value,
- any field named `id`, `*Id`, `*_id` or `uuid`.

Common words and numbers are excluded: status codes, ports, the years 2000–2099, `true`/`false`.

The trace footer lists what actually matched ("Matched by: x-request-id aux-7f3a91 · jobId 8f2c1e"), so you can see why each line is there.

Matching runs in TypeScript in the webview over the buffers it already holds. Cost: about 1–2 ms for ten services × 10k lines.

### 5.4 Hops

- **Hop order:** by the first tier-1 or tier-2 line from each service. The entry service (the URL's target) is always first.
- **Hop time:** the span from that service's first to last matched line. The entry service uses the HTTP response time instead. Spans are labelled "≈" in the tooltip, because log timestamps show when a line was printed, not when work started or ended.
- **Hop failed** when a matched line is error-level (`error|exception|traceback|fatal|panic`, or stderr containing one of those) or the service crashed during the window.
- The canvas shows the hops for the open request (others dimmed). During a run it plays them in order: amber, then green or red.

## 6. HTTP client

Requests are sent from **Rust**, not from the webview's `fetch`. That means:
- no CORS;
- `Origin`, `Cookie` and `Host` can be set (your PATCH sets `origin`);
- accurate timings;
- no browser connection limits.

**Command:** `step_exec({ kind: "http", …req }) → { kind: "http", …response }`, cancelled with `step_cancel(id)`. Every step kind goes through these two commands.

- **Library:** `reqwest` (rustls, gzip/brotli, HTTP/1.1 + HTTP/2) on the Tauri async runtime.
- **Request:**
  - method, url, headers, and a body as text, base64 or a file path (read by Rust)
  - `timeoutMs` (default 30 s)
  - `followRedirects` (default true, max 10)
  - `insecureTls` (default false; per-environment toggle for self-signed local certs)
  - `cookieJar` id (one jar per run, so login-then-call flows work)
- **Response:**
  - status, status text, headers (ordered, duplicates kept)
  - body as UTF-8 text when possible, else base64 with the content-type
  - size
  - timings: time to response headers ("first byte") and total. A DNS/connect/TLS breakdown would need a custom connector, so it's deferred.
- **Large bodies:** responses over 10 MB are truncated in the UI with "Save full response…".
- **Cancel:** `step_cancel(id)` aborts an in-flight request; Stop cancels every request in flight, including all of a parallel block's. A cancel that arrives before its request reaches the backend is remembered, so the request is never sent (`steps.rs`, `INFLIGHT`).
- **Network rules:** the environment's `network` (§2.2) is sent with each request and enforced in Rust (`netpolicy.rs`).
- **Content types:** JSON is pretty-printed with syntax colour (prototype), with copy/collapse/search. Other types show as text. Images and PDFs show a preview, or "binary, N KB" with a save button.

**curl:**
- Import uses `src/lib/curl.ts`, already built and tested. It recovers from unclosed quotes and warns about missing tokens.
- A pasted `localhost:<port>` URL is rewritten to `{{alias}}` (prototype behaviour). A pasted `Authorization` value is moved to a secret var (`{{token}}`, or `{{token2}}` when `token` already exists), so it never lands in git.
- Export: "Copy as curl" with variables resolved, and secrets resolved only when the user confirms.

## 7. UI

The UI follows the approved prototype:
- n8n-style canvas: paper nodes, links labelled by source, pan/zoom/fit, resizable height, edge panel with Keep/Remove, + Services, → Direction, Auto-arrange.
- Linear-style request rows that open into an Insomnia-style request | response split.
- Response tabs: Trace (default) · Response · Headers.

Additions beyond the prototype:
- the sample pass/fail switch is removed;
- request rows can be reordered by drag;
- step names are editable inline;
- ⌘↵ sends the open request; ⌘⇧↵ runs the flow;
- a run history drawer shows past runs with diffs of status and time.

## 8. Code layout

- **Rust** (`src-tauri/src/`):
  - `http.rs`: `http_send`, `http_cancel`
  - `deps.rs`: static scan
  - `flows.rs`: read, write and watch `.auxin/`, gitignore upkeep
  - `conns.rs` (phase 4b): connection sampling
- **TS:**
  - `src/flows/model.ts`: types matching §2
  - `src/flows/vars.ts`: resolution, path syntax, checks
  - `src/flows/runner.ts`: run, poll, cancel
  - `src/flows/trace.ts`: matching and hops
  - `src/flows/*.tsx`: UI, promoted from `src/prototype/`, which is then deleted
- **Tests:**
  - Rust unit tests for `http_send` against a local test server, plus `deps` against fixture folders
  - Vitest (new dev dependency) for `vars`, `trace` and `curl`
  - one end-to-end run against the dev mock backend

## 9. Migration

On first launch of the new version, each existing flow (a launch set in `auxin.json`) becomes a group with the same name and services. A one-time notice says "Flows now chain HTTP requests; your old flows are now groups". The old flow runner and `FlowView` are removed.

## 10. Build phases (one commit each; I stop after each for you to review and commit)

1. **Client:**
   - `http_send`/`http_cancel` and flow files (read, write, watch)
   - single request rows with the request/response split
   - curl import/export, environments and secrets
   - migration of old flows
2. **Chains:** variables, extract, checks, poll, Run flow, cancel, run history.
3. **Tracing:** header injection, line matching, hops, Trace tab, canvas playback.
4. **Service map:**
   - canvas with saved layout
   - static direction detection and traffic edges
   - edge panel
   - 4b: connection sampling, if wanted.

## 11. Out of scope for v1

- gRPC, WebSockets, queues (Kafka/SQS)
- tailing log files of services Auxin didn't start
- scripting (pre-request JS)
- OpenAPI import
- parallel steps
- load testing

Each can come later without changing the file format; `version` is bumped if it ever must change.

## 12. Decisions (settled 2026-10-24)

1. **Secrets:** gitignored `.auxin/env/<name>.secret.json`, added to `.gitignore` automatically. No Keychain in v1.
2. **Trace headers:** `X-Request-ID` and `traceparent` are injected by default; this can be turned off per flow.
3. **Run history:** kept in the workspace, at `.auxin/runs/` (gitignored).
4. **Connection sampling:** included, as phase 4b.

## 13. As built: differences from the draft

- **Rust module names:** `workspace_files.rs` (not `flows.rs`), plus `deps.rs` and `conns.rs`.
- **JSON bodies with unquoted placeholders** (`{"n": {{count}}}`) are saved as `{"jsonText": "…"}` so they round-trip exactly.
- **Remembered ports:** Auxin remembers the last port each service announced (`lastPort` in its settings), so `{{service}}` resolves while the service is stopped.
- **Default pass/fail:** a request with no checks passes when its status is below 400 (shown as an implicit "status < 400" check). A failed `extract` also fails the request, so later requests never run with a missing value.
- **Single Send:** single Send reuses values extracted by earlier single sends, as well as by runs, so requests can be tried one by one.
- **Excluded trace lines:** a log line tagged with a *different* `aux-…` request id is excluded from a trace, even if it shares a value (e.g. a job id) with this request.
- **Unmapped flows:** when a flow has no service map, every running service counts as "in the flow" for nearby lines.
- **Connection edges:** connection-sampled and traced directions are added unconfirmed (dashed) until kept. Statically detected ones are added confirmed, with their evidence.
- **Not done:**
  - the per-file mtime cache for the static scan (scans are fast without it);
  - Windows connection sampling (returns nothing for now);
  - a DNS/connect/TLS timing breakdown.
