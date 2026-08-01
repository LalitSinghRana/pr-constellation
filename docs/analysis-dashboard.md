# Analysis Dashboard

The local cockpit tracks GitHub pull requests and their AI analysis status in
one website.

```sh
pnpm web
```

- Inbox: <http://127.0.0.1:4397/>
- Analysis status: <http://127.0.0.1:4397/analysis>
- Stable review tree: `http://127.0.0.1:4397/reviews/<review-slug>/`

## Run semantics

- New PRs are queued smallest-first from changed lines and file count.
- One analysis runs at a time.
- Mini-tree generation and repair use the provider's highest configured effort
  (`xhigh` for Codex and `max` for Claude).
- Deterministic validation is the active gate; the semantic judge remains
  available for offline benchmarking but is disabled in the active pipeline.
- Cancel stops queued or running work without deleting completed history.
- A successful run updates the PR's stable generated-review URL.

## Local API

- `GET /api/dashboard` returns saved PRs, queue state, configuration, and runs.
- `POST /api/runs` queues `{ "prUrl": "...", "title": "...", "refresh": true }`.
- `POST /api/runs/<review-slug>/<run-id>/cancel` cancels a queued or running run.
- `DELETE /api/runs/<review-slug>/<run-id>` deletes completed local history.

## Persistence

Run state stays under the gitignored `.reviews/` directory. Each run stores its
metadata, timings, diff, analysis, and generated HTML. The stable
`.reviews/<review-slug>/index.html` points to the latest successful result.

Inbox state is stored separately at
`~/.config/pr-review-cockpit/queue.json`. GitHub's read flag does not change
local read or Done state.
