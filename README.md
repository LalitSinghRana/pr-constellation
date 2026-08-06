# PR Review Cockpit

An early-stage project for a human-first pull request review assistant.

The goal is to help reviewers move through large PRs quickly by showing the
feature intent, highest-signal files, causal review tree, acceptance criteria,
and senior/product/QA review risks without drowning them in generated files,
tests, fixtures, or Storybook noise.

## Code Organization

- `client/` owns the cockpit UI, generated React Flow review pages, renderer,
  Shiki integration, shared shadcn primitives, and browser-facing checks.
- `server/` owns the continuously running HTTP server, GitHub notification sync,
  dashboard API, queue coordination, persistence, and server checks.
- `analysis-worker/` owns the CLI, run coordinator, PR fetching, diff inventory,
  prompts, schemas, validation, judging, retry orchestration, and analysis checks.

These directories are ownership boundaries inside one Node and pnpm project,
not independently packaged workspaces.

One root `biome.json` supplies linting and formatting for all three areas. Run
`pnpm check` for formatting, lint, tests, and a production client build; run
`pnpm format` to apply the formatter.

## Dirty v0

Install dependencies:

```sh
pnpm install --registry=https://registry.npmjs.org/
```

Generate a local review page for a GitHub PR:

```sh
pnpm prc -- https://github.com/OWNER/REPO/pull/123
```

Open it automatically:

```sh
pnpm prc -- https://github.com/OWNER/REPO/pull/123 --open
```

Generate a Codex-backed logical review tree:

```sh
pnpm prc -- analyze https://github.com/OWNER/REPO/pull/123
```

Render an existing run directory, including the review tree when `analysis.json`
exists:

```sh
pnpm prc -- view .reviews/REVIEW-SLUG/2026-01-01T00-00-00-000Z --open
```

Start the local cockpit:

```sh
pnpm dev
```

The inbox is the home page and analysis status has its own route:

```text
http://127.0.0.1:4397/
http://127.0.0.1:4397/analysis
```

The inbox persists tracked PRs independently from GitHub's read state. The
analysis page shows not-started, queued, running, completed, and failed work;
File Tree and Section Tree generation and repair use the provider's highest configured effort
(`xhigh` for Codex, `max` for Claude).

The latest generated run for each PR is available at a stable URL:

```text
http://127.0.0.1:4397/reviews/REVIEW-SLUG/
```

Timestamped revision URLs remain available for historical runs:

```text
http://127.0.0.1:4397/reviews/REVIEW-SLUG/2026-01-01T00-00-00-000Z/
```

The CLI uses local `gh` authentication, fetches PR metadata and the cumulative
diff, then writes a timestamped run under `.reviews/<repo-pr-number>/`.
Dashboard history and timing data are persisted in those run directories and
survive stopping or restarting the local server. See
[`docs/analysis-dashboard.md`](docs/analysis-dashboard.md) for the storage
layout and benchmark semantics.

Install the hourly GitHub reconciliation worker once with `pnpm install:sync`.
Run `pnpm sync` for a manual refresh. Queue state is stored in
`~/.config/pr-review-cockpit/queue.json`; generated analyses remain under the
gitignored `.reviews/` directory.

The `analyze` command is headless. It invokes `codex exec` in read-only mode and
writes one Section Tree per changed file to `analysis.json`; it does not
render the review page. The page nests each file's Review Sections beneath its
Review Stack's File Tree and renders those sections as code diffs. Ordered
Review Branches follow AI-authored review causality. Secondary and skim branches
start in deterministic expandable Review Groups so the first pass stays focused.

See [`docs/terminology.md`](docs/terminology.md) for the canonical product and
data-model vocabulary.
