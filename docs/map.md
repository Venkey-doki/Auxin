# Project map

The **Map** screen (sidebar, under Running now) shows every service in the workspace, the databases, caches, queues and outside APIs they use, and the links between them. Each flow's own canvas shows the same links, limited to that flow's services.

## Three inputs, kept apart

| Input | Where it comes from | Stored in | In git? |
|---|---|---|---|
| **Discovered** | Project files, read by the backend (`discover_topology`, `src-tauri/src/topology.rs`) | recomputed on open and on Scan | — |
| **Observed** | What runs showed: a request traced through two services' logs, or an open TCP connection between them | `.auxin/runs/observed.json` | no |
| **Your edits** | Links you added or kept, links and nodes you removed, nodes you added, positions | `.auxin/topology.json` | yes |

Your edits win: a removed link or node stays removed however often it's found again, until you bring it back from the list on the Map screen.

If `topology.json` can't be read (often a git merge conflict), the Map screen says so and edits aren't saved until it's fixed, so the file is never overwritten with a partial map. Old flow files keep their links until then, too.

## What discovery reads

- **docker-compose** files at the root and in each service folder: services (matched to folders by `build` context or name), images (postgres → database, redis → cache, rabbitmq/kafka → queue, …), published ports, `depends_on` and `links` (**declared**), and URLs in `environment` (**inferred**).
- **.env** files in each service: database, cache and queue URLs (`postgres://`, `redis://`, `amqp://`, `KAFKA_BROKERS`, …) and outside APIs (`https://api.stripe.com`).
- **Kubernetes** manifests (best-effort, matched by name; Helm templates are skipped).
- **Config files** in each service (`config/`, `*.config.*`, `settings.py`, `appsettings.json`, …).
- **Source code** only after you turn on *Code scan* on the Map screen. That choice is saved in this machine's Auxin settings for the workspace, never in the project, so a teammate's checkout doesn't read code without their consent.

Passwords never reach the map: URL credentials become `••••`, and values of keys like `PASSWORD`, `SECRET`, `TOKEN`, `API_KEY` become `••••••`, before evidence leaves the backend.

## How links are drawn

Each link shows its strongest evidence:

- **Added or kept by you** and **declared** (compose `depends_on`): solid.
- **Seen at runtime** (traces, connections in the last 7 days): solid.
- **Inferred from files** (a URL in .env or config): dashed, marked `?`. *Keep link* makes it yours.

Selecting a link lists every piece of evidence (`file:line  snippet`, or when it was last seen) with Keep and Remove.

## `.auxin/topology.json`

```json
{
  "version": 1,
  "nodes": [{ "key": "stripe", "kind": "external", "label": "Stripe", "endpoint": "api.stripe.com" }],
  "edges": [{ "from": "api-gateway", "to": "postgres", "kind": "database" }],
  "removed": ["api-gateway→auth-service"],
  "positions": { "postgres": { "x": 320, "y": 40 } }
}
```

Node keys: a service's folder relative to the workspace (`apps/web`), a compose/k8s name (`postgres`), `<tech>@<host>:<port>` for infrastructure only found in a URL, or `ext:<host>` for outside APIs.
