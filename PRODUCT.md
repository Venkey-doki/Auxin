# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Rendered inside a Tauri desktop shell. macOS is the only target today; the product is meant to launch publicly later, so nothing should assume a single machine, a single user's folder layout, or macOS-only behavior where a portable choice costs nothing.)

## Stack

Tauri 2 (Rust backend) + Vite + React + TypeScript, chosen by the user.

## Users

Backend / full-stack developers who run a system of 5–10 local services (Node, Python, others) to test end to end on their own machine. Today they open one editor window per service, start each by hand, and switch windows to read logs; windows get buried and the state of the system is invisible.

## Product Purpose

Auxin is a local microservice manager: point it at a folder of service repos, and it finds the services, starts and stops them, and shows their logs together in one place. Success is the developer starting a whole end-to-end stack with one click and diagnosing it without leaving the app.

## Positioning

Zero-config start: Auxin reads the folder itself (package.json scripts, Python entry points, virtualenvs, Makefiles…) instead of asking the developer to write a compose/Procfile/Tiltfile first. Config is added only where detection is wrong.

## Operating Context

- A workspace is one root folder whose child folders are service repos (e.g. `~/code` holding `api-gateway`, `orders-service`, `pricing-model`, …).
- Services are long-running dev processes (`npm run dev`, `python main_local.py`, `uvicorn …`). Some take a while to become ready; some depend on others being up.
- Used alongside the editor and terminal for hours at a time, often on a laptop screen.

## Capabilities and Constraints

- **Detect services** from a granted root folder and list them; one click starts or stops a service.
- **Custom command** per service overrides the detected one; cwd and env vars are editable.
- **Python virtualenvs** found in a service folder are activated automatically; per-service toggle to turn this off.
- **Groups**: user-made collections of services whose logs/terminals are shown together in one view.
- **Flows** (redefined 2026-10-24; launching a set of services is what groups do): a flow is an ordered chain of HTTP requests against the running services. Later steps reuse values from earlier responses (e.g. `{{step1.body.jobId}}`), steps can poll until a condition holds, and simple checks assert on status/body. A step can be written as a form or pasted as curl. Running a flow shows each response and **traces** the request through the services: a service map with the hops lit in order, plus a time-ordered timeline of the matching log lines from every service. The services in a flow and the direction requests travel between them are auto-detected (from config/env URLs, code, and observed traffic), then editable.
- Flows must work for any project type and protocol shape the user brings (REST/JSON first; any language or framework on the service side), with no instrumentation required in the services. Flows are saved as files in the workspace (`.auxin/flows/*.json`) so teams can share them through git.
- Child processes must never outlive the app: quitting Auxin stops everything it started.
- Terminology: *workspace*, *service*, *group*, *flow*, *command*.

## Brand Commitments

Name: **Auxin** (user-chosen). No logo or voice assets exist yet.

## Evidence on Hand

None. No users, testimonials, benchmarks or press exist; do not fabricate any.

## Product Principles

1. Detection first, configuration second — the empty state should already show the user's services.
2. The state of the whole system is visible at a glance; nothing important hides in another window.
3. Starting the stack is one action; diagnosing it is one view.
4. Never leave orphaned processes behind.
5. Build as a product, not a personal script: no hard-coded paths or assumptions about one user's folders.
