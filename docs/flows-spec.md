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
| Run history (last 20 runs per flow) | `<workspace>/.auxin/runs/<slug>/<timestamp>.json` | no |
| Canvas layout (node positions) | inside the flow file | yes |

- Paths inside flow files are relative to the workspace root, so a teammate's checkout in a different folder works unchanged.
- A service is referred to by its folder path relative to the root (e.g. `api-gateway`). It is never referred to by its absolute path, which is today's internal service id.
- Files are written atomically (temp file, then rename), as `auxin.json` is today.
- Auxin watches `.auxin/flows/` and reloads when a file changes on disk, for example after a `git pull`.

### 2.1 Flow file (`*.flow.json`)

```json
{
  "$schema": "https://auxin.dev/schema/flow-1.json",
  "version": 1,
  "name": "Checkout end to end",
  "services": [
    { "ref": "api-gateway", "alias": "api-gateway", "x": 0, "y": 0 },
    { "ref": "orders-service", "alias": "orders", "x": 288, "y": 53 }
  ],
  "directions": [
    { "from": "api-gateway", "to": "orders", "source": "env",
      "evidence": "api-gateway/.env: ORDERS_URL=http://localhost:8000", "confirmed": true }
  ],
  "trace": { "injectHeaders": true, "graceMs": 1500 },
  "steps": [
    {
      "id": "submit",
      "name": "Submit job",
      "method": "POST",
      "url": "{{api-gateway}}/jobs",
      "headers": { "Content-Type": "application/json", "Authorization": "Bearer {{token}}" },
      "body": { "file": "fixtures/create-order.json" },
      "extract": { "jobId": "body.jobId" },
      "checks": [ { "left": "status", "op": "==", "right": 202 } ],
      "poll": null,
      "timeoutMs": 30000
    }
  ]
}
```

- `alias` is the short name used in `{{variables}}` and on the canvas. It defaults to the detected service name and can be edited.
- `body` is one of:
  - `{ "json": … }`
  - `{ "text": "…" }`
  - `{ "form": { … } }` (url-encoded)
  - `{ "file": "relative/path" }`
  - `null`
- `headers` is an ordered object. Duplicate header names are not supported in v1.

### 2.2 Environment and secret files

```json
// .auxin/env/local.json
{ "vars": { "region": "eu-west" }, "baseUrls": { "api-gateway": "http://localhost:4000" } }
// .auxin/env/local.secret.json  (gitignored)
{ "vars": { "token": "eyJhbGciOi…" } }
```

- `baseUrls` is optional. When a service has no entry, `{{alias}}` resolves to `http://localhost:<port>` from the service's detected or announced port (§4.1).
- The environment picker in the top bar lists every file in `.auxin/env/`. `local` is created automatically.

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

`right` is a JSON literal. If any check fails, the step fails and the remaining steps are marked *skipped*.

**Poll:** `{ "until": <check or list of checks>, "everyMs": 1000, "maxTries": 30 }`.
- Re-sends until the condition holds.
- Uses the last response.
- After `maxTries`, the step fails with "condition not met after N tries".

**Single-step send:** Send runs one step using the variables extracted by the latest run. It warns if a needed variable has never been extracted.

## 4. Direction detection

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

**New command:** `http_send(req) → response`.

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
- **Cancel:** `http_cancel(id)` aborts in-flight requests (Stop button).
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
