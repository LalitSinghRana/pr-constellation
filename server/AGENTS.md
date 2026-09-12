# AGENTS.md — server/

## Commands

- `pnpm dev` — development daemon with Vite (`server/server.mjs --dev`)
- `PRC_DISABLE_SYNC=1 pnpm dev` — disable GitHub background sync

## Tech stack

- **Runtime:** Node 24 ESM (`.mjs` entry points where established)
- **HTTP:** native `node:http`, SSE via `server/http/event-hub.js`
- **Persistence:** better-sqlite3 (WAL mode, owner-only permissions)
- **GitHub:** `gh auth token` at runtime (no persisted tokens in repo)
- **Default bind:** `127.0.0.1:4397` (override with `PORT`)

## Architecture

One local Node.js daemon hosts PR Constellation, JSON API, GitHub sync, queue
coordination, and bounded analysis scheduler.

```text
Node.js coordinator (127.0.0.1:4397)
├── production client/dist hosting + local JSON API
├── Server-Sent Events invalidation stream
├── GitHub inbox poller
├── SQLite queue and run metadata
└── bounded analysis scheduler
    └── analysis CLI subprocesses
```

### Module ownership

- `server/server.mjs` — process entry point
- `server/http/http-server.js` — HTTP composition, static hosting, shutdown
- `server/inbox/inbox-service.js` — inbox ranking, GitHub reconciliation, inbox API
- `server/inbox/sync-scheduler.js` — single-flight sync (~60s interval, Retry-After backoff)
- `server/analysis/dashboard-service.js` — durable analysis queue (max 2 PRs concurrent,
  serial per PR, max 3 model subprocesses process-wide)
- `server/http/event-hub.js` — SSE invalidation; browser refetches authoritative state

State-changing APIs reject cross-origin requests and require JSON semantics.

### Persistence

| Path | Contents |
|---|---|
| `database/cockpit.sqlite3` | Settings, sync cursors, inbox queue, drafts, conversations |
| `.reviews/.run-store.sqlite` | Analysis manifests, timings, queued jobs |
| `.reviews/<slug>/` | Immutable diffs, analysis JSON, rendered HTML |

Legacy `settings.json` and `queue.json` under `database/` import once and are
left as rollback aids.

Queued analyses resume after daemon restart. Actively running work during unclean
stop is marked interrupted; frozen-input batch dependencies restart from source
when input was not fully persisted.

### Local API (analysis dashboard)

- `GET /api/dashboard` — PRs, queue state, configuration, runs
- `POST /api/runs` — queue `{ "prUrl": "...", "title": "...", "refresh": true }`
- `POST /api/runs/<review-slug>/<run-id>/cancel` — cancel queued or running run
- `DELETE /api/runs/<review-slug>/<run-id>` — delete completed local history

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP listen port (default `4397`) |
| `PRC_DISABLE_SYNC` | Set to `1` to disable GitHub background sync |
| `PRC_CURSOR_AGENT_TIMEOUT_MS` | Cursor Agent subprocess timeout |
| `PRC_CLAUDE_TIMEOUT_MS` | Claude CLI subprocess timeout |
| `PRC_CODEX_TIMEOUT_MS` | Codex CLI subprocess timeout |
| `PRC_CODEX_MODEL` | Override Codex model |
| `PRC_CODEX_REASONING_EFFORT` | Override Codex reasoning effort |

## Conventions

- Keep entry points thin; validate at HTTP boundaries (`server/inbox/inbox-service/http-guards.js`).
- Tests live in `server/tests/`. Use temporary directories and random ports.
- No Redis, ORM, WebSocket layer, or second backend language unless a measured
  requirement cannot be met by the single local daemon.
