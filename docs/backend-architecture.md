# Backend Architecture

PR Review Cockpit runs as one local Node.js daemon. Keeping one runtime is deliberate: the HTTP
API, queue coordinator, analysis workflow, renderer, and client already share JavaScript contracts,
while the previous idle cost came primarily from keeping Vite active and repeatedly rebuilding
large JSON responses. A second language would add packaging and IPC without removing those costs.

```text
macOS launchd user agent
└── Node.js coordinator (127.0.0.1:4397)
    ├── production client/dist hosting + local JSON API
    ├── Server-Sent Events invalidation stream
    ├── conditional GitHub notification poller
    ├── SQLite queue and run metadata
    └── bounded analysis scheduler
        └── Codex or Claude subprocesses
```

## Runtime responsibilities

- `server/server.mjs` is the process entry point.
- `server/http/http-server.js` owns HTTP composition, production static hosting, startup, and graceful
  shutdown. Vite is loaded only by `pnpm dev`.
- `server/inbox/inbox-service.js` owns inbox ranking, GitHub reconciliation, and its local API.
- `server/inbox/sync-scheduler.js` makes scheduled and manual synchronization single-flight. It performs
  an initial/full reconciliation, repeats that hourly, and uses lightweight conditional notification
  requests between reconciliations. GitHub's `X-Poll-Interval`, `Last-Modified`, `Retry-After`, and
  exponential failure backoff control request frequency.
- `server/analysis/dashboard-service.js` owns the durable analysis queue. At most two different PRs run at
  once; runs for one PR remain serial. Model execution is capped at three subprocesses across the
  process, including sharded File Tree generation. The renderer and analysis worker are loaded only
  when a job actually starts, keeping the idle daemon small.
- `server/http/event-hub.js` sends small invalidation events. The browser refetches authoritative state;
  it does not rely on an in-memory event log.

The server listens only on `127.0.0.1`. State-changing APIs reject cross-origin requests and require
JSON request semantics, preventing an unrelated webpage from triggering synchronization or paid AI
work on the local daemon.

## Persistence

Mutable state uses SQLite in WAL mode with short transactions and a five-second busy timeout:

- `~/.config/pr-review-cockpit/cockpit.sqlite3` stores settings, synchronization cursors, and inbox
  queue rows.
- `.reviews/.run-store.sqlite` stores analysis manifests, timings, and durable queued jobs for this
  checkout.

Large immutable inputs and generated review assets remain ordinary files under `.reviews/<slug>/`.
This keeps diffs and rendered pages easy to inspect without putting multi-megabyte blobs through the
database. Existing `settings.json`, `queue.json`, `run.json`, and `timings.json` documents are imported
once and left untouched as a rollback aid. State directories use owner-only permissions, as do the
SQLite databases and their WAL files.

Queued analyses resume after a daemon restart. Work that was actively running during an unclean stop
is marked interrupted because model subprocess execution cannot be resumed safely from the middle.
If queued batch runs still depend on that source and its frozen PR input was not fully persisted, the
source job restarts from the beginning before its dependents; complete frozen input is reused as-is.

## Browser notifications

Server-Sent Events are the right first transport for an open cockpit: updates are one-way, native to
the browser, and use one idle connection instead of frequent polling. A later opt-in feature can feed
those events to the Notifications API while the page is open. Delivery while every cockpit tab is
closed is a separate requirement and should add a service worker plus Web Push only when needed.

## Operations

```sh
# Development: Vite middleware and hot reload
pnpm dev

# Production: build once, then serve static assets from the daemon
pnpm build
pnpm start

# Install/update the continuously running macOS user service
pnpm install:service

# One manual full reconciliation without starting the HTTP daemon
pnpm sync
```

The launchd installer uses `RunAtLoad` and `KeepAlive`, writes logs under
`~/.config/pr-review-cockpit/`, and refuses to install while another process owns port `4397`.

There is intentionally no Redis, ORM, container, WebSocket layer, microservice split, or second
backend language. Add one only when a measured requirement cannot be met by the single local daemon.
