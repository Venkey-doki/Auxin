# Contributing to Auxin

## Set up

Requirements: Rust (stable), Node 20+, and on macOS the Xcode Command Line Tools.

```bash
npm install          # also installs the git hooks (lefthook)
npm run tauri dev    # the desktop app with hot reload
npm run dev          # the UI only, in a browser, with a fake backend (src/dev/mockBackend.ts)
```

## Checks

| Command | What it does |
|---|---|
| `npm run format` | Formats TypeScript, JSON and CSS (Prettier) and Rust (rustfmt) |
| `npm run format:check` | Checks formatting without changing files |
| `npm run lint` | ESLint |
| `npm run lint:rust` | Clippy, with warnings as errors |
| `npm run typecheck` | TypeScript |
| `npm test` | Frontend tests (Vitest) |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust tests |
| `npm run test:coverage` / `npm run coverage:rust` | Tests with coverage (see below) |

The git hooks run these for you:

- **pre-commit:** formats the files you're committing and re-stages them.
- **commit-msg:** checks the message format (below).
- **pre-push:** format check, ESLint, Clippy, typecheck and both test suites, in parallel. It runs when there are commits to push.

CI runs the same checks on every pull request, so skipping a hook (`--no-verify`) only moves the failure there.

## Coverage

```bash
npm run test:coverage   # frontend: coverage/frontend (open lcov-report/index.html)
npm run coverage:rust   # Rust: coverage/rust/lcov.info
```

The Rust command needs `cargo-llvm-cov` once: `rustup component add llvm-tools-preview && cargo install cargo-llvm-cov --locked`.

The rules:

- **New and changed code in a pull request must be 90% covered**, branches included: a branch that's only half taken counts against it. Codecov checks this on every pull request (`codecov.yml`).
- **Overall coverage may not drop.** Codecov compares with `main`, and both commands above fail below a floor at today's level (`vite.config.ts`, and `--fail-under-lines` in `package.json`). Raise the floors when coverage goes up.

Rust branch coverage needs a nightly compiler, so for Rust the 90% applies to lines.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<optional scope>): <summary in lower case, no full stop>
```

| Type | For |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `style` | Formatting, no code change |
| `refactor` | A code change that's neither a fix nor a feature |
| `perf` | Performance |
| `test` | Tests only |
| `build` | Build system or dependencies |
| `ci` | CI configuration |
| `chore` | Anything else (tooling, config) |
| `revert` | Reverting an earlier commit |

Scopes are optional; use the area you changed, e.g. `flows`, `map`, `otel`, `queue`, `services`. Mark a breaking change with `!` (`feat(flows)!: drop version 1 flow files`) and explain it in the body.

Examples:

```
feat(flows): retry a request on 5xx responses
fix(map): keep kept links when topology.json fails to parse
docs: explain the first-launch step on macOS
```

Pull requests are squash-merged, so the PR title becomes the commit on `main` and must follow the same format.

## Formatting history

The whole codebase was reformatted once. To keep `git blame` pointing at real changes, run once:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```
