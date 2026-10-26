---
version: 1
slug: "src-flows-flowscreen-tsx"
primary_target: "src/flows/FlowScreen.tsx"
related_targets: []
---

Scope: the Flows screen (request flows + tracing). Mode: Operate. Inherits the established world in DESIGN.md ("The Pass"); no world change.

Audience/job: a developer with their stack running chains HTTP requests across services (submit job → poll → fetch result), sees each response, and follows each request through the services' logs to find where it failed or slowed. Must work for any project/language; no instrumentation in services.

Chosen structure: Run notebook (surface seed c743f710), then revised by the user: n8n-style service canvas over Linear/Insomnia-style request rows, in Auxin's look.
- Top bar: flow name, environment, Run flow.
- Services strip: the flow's services as small tickets with auto-detected direction arrows (sources: env/config URLs, code references, observed traffic); editable.
- Body: step cells top to bottom. Each cell = paper request header (method, URL with {{vars}}, Send) with tabs Body / Headers / Extract / Checks / Poll, curl import; beneath it the output: status, time, size, response, extracted values, check results, and that step's trace (lit hop path with per-hop timing + matching log lines, tagged by service, with how they were matched: injected request id, extracted value, or time window).
- Memorable moment: on Run, the strip's arrows light hop by hop as each step's trace lands; a failing hop stamps red in both the strip and the cell.

Built as src/flows/ (FlowScreen, FlowCanvas); the prototype was removed once promoted.

Unresolved: auth/secrets handling in requests; non-HTTP protocols (gRPC, queues) later.
