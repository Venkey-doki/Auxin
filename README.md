# Auxin

A desktop app for running a stack of local microservices from one window, instead of one editor window per service.

- **Detects services**: open a folder and Auxin lists every service repo inside it, each with a Start button. It reads `package.json` scripts (npm/pnpm/yarn/bun), Python entry points (`main_local.py`, `uvicorn` apps, Django), virtualenvs (any folder with `pyvenv.cfg`, e.g. a custom-named `py-env`), Makefile targets, Procfiles, Go, Rust, Maven/Gradle and docker-compose.
- **Custom commands**: each service can have its own start command, working folder, env vars and virtualenv toggle. Commands run in your login shell's environment, so `nvm`, `pyenv` and friends work.
- **Groups**: put services side by side (Columns or Grid, one log column per service) or in one colour-tagged Merged stream.
- **Flows**: chain HTTP requests across your running services and see how each one went (`.auxin/flows/*.flow.json`, shareable through git):
  - paste a curl or build a request; `{{service-name}}` resolves to the service's address, `{{token}}`-style secrets live in a git-ignored file;
  - extract values from a response (`body.jobId`) into later requests, add checks (`status == 202`), and poll until a condition holds;
  - every request is traced through your services' logs (Auxin adds `X-Request-ID` / `traceparent` and also matches ids like job ids), shown as a waterfall of hops plus the matching lines;
  - an n8n-style map of the flow's services, with call directions detected from env/config/code, traces and live connections;
  - run history with per-request comparisons against the previous run (`.auxin/runs/`, git-ignored).
- **Logs**: follow-tail with a "N new" jump pill, a filter, an errors-only toggle, timestamps, wrap, ANSI colours, and stdin input for the selected service.
- **No orphans**: every service runs in its own process group. Stop kills the whole tree (SIGTERM, then SIGKILL after 5 s), and quitting Auxin stops everything.

Shortcuts: `⌘K` jump to anything · `⌘1`–`⌘9` open service by its number · `⌘0` Running now · `⌘B` sidebar · in a flow, `⌘↵` sends the open request and `⌘⇧↵` runs the flow.

## Develop

Requirements: Rust (stable), Node 20+, Xcode Command Line Tools.

```bash
npm install
npm run tauri dev     # desktop app with hot reload
npm run dev           # UI only, in a browser, with a fake backend (src/dev/mockBackend.ts)
npm run tauri build   # .app / .dmg in src-tauri/target/release/bundle
```

Tests:

```bash
cd src-tauri && cargo test --lib -- --test-threads=1
AUXIN_SCAN_ROOT=~/code cargo test scan_prints -- --nocapture --ignored   # print what the scanner detects
```

## Layout

- `src-tauri/src/scan.rs`: service detection and command suggestions
- `src-tauri/src/process.rs`: spawning, process groups, batched log streaming, login-shell env capture
- `src-tauri/src/lib.rs`: Tauri commands, config persistence (`~/Library/Application Support/com.auxin.app/auxin.json`), shutdown on exit
- `src-tauri/src/http.rs`: HTTP client for flows (reqwest; cancel, cookie jars, large bodies)
- `src-tauri/src/workspace_files.rs`: the workspace's `.auxin/` folder (atomic writes, watcher, `.gitignore` upkeep)
- `src-tauri/src/deps.rs`, `conns.rs`: call-direction detection (static scan; `lsof` connection sampling)
- `src/state/store.ts`: app state, workspaces, groups
- `src/flows/`: flows: model and file format, variables, checks/paths, runner, tracing, screens
- `src/state/logs.ts`: per-service ring buffers (10k lines each), kept outside React state
- `src/components/`: UI (Tailwind v4; design tokens live in `src/styles.css`)

Tests: `npm test` (Vitest: curl import, variables, checks, tracing, the runner against a fake HTTP layer) and `cd src-tauri && cargo test --lib -- --test-threads=1`.

Design context: `PRODUCT.md`, and the direction contract in `.impeccable/surfaces/`.
