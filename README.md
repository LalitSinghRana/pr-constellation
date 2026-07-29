# PR Review Cockpit

An early-stage project for a human-first pull request review assistant.

The goal is to help reviewers move through large PRs quickly by showing the
feature intent, highest-signal files, causal change path, acceptance criteria,
and senior/product/QA review risks without drowning them in generated files,
tests, fixtures, or Storybook noise.

## Code Organization

- `src/` is the generated-review website: HTML renderer, React Flow
  application, tree presentation model, styles, and shadcn components.
- `cli/` contains the command-line interface and the run coordinator that
  connects analysis output to rendering.
- `workflows/pr-graph-analysis/` contains the complete headless AI analysis
  workflow: PR fetching, diff inventory, prompts, schemas, validation, judging,
  retry orchestration, and analysis tests.
- `tests/webview/` contains website rendering and presentation-model regression
  checks.
- `notifications/` is the standalone local GitHub notification-priority app;
  it has its own npm dependencies and run instructions.

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

Generate a Codex-backed logical review graph:

```sh
pnpm prc -- analyze https://github.com/OWNER/REPO/pull/123
```

Render an existing run directory, including the graph when `analysis.json`
exists:

```sh
pnpm prc -- view .reviews/REVIEW-SLUG/2026-01-01T00-00-00-000Z --open
```

Serve generated reviews with Vite on the fixed local port:

```sh
pnpm web
```

This starts the local benchmark dashboard:

```text
http://127.0.0.1:4173/reviews/
```

Choose an OpenAI or Claude model and paste a GitHub pull request URL to queue
one review run. Mini-tree generation and repair use the provider's highest
configured effort (`xhigh` for Codex, `max` for Claude); the semantic judge
is retained for offline benchmarking but disabled in the active pipeline.
Re-running uses the exact saved PR metadata and diff by default.
**Refresh from GitHub** deliberately fetches the current PR state first, and
**Cancel run** terminates the active process tree without deleting completed
history.

The latest generated run for each PR is available at a stable URL:

```text
http://127.0.0.1:4173/reviews/REVIEW-SLUG/
```

Timestamped revision URLs remain available for historical runs:

```text
http://127.0.0.1:4173/reviews/REVIEW-SLUG/2026-01-01T00-00-00-000Z/
```

The CLI uses local `gh` authentication, fetches PR metadata and the cumulative
diff, then writes a timestamped run under `.reviews/<repo-pr-number>/`.
Dashboard history and timing data are persisted in those run directories and
survive stopping or restarting the local server. See
[`docs/benchmark-dashboard.md`](docs/benchmark-dashboard.md) for the storage
layout and benchmark semantics.

The `analyze` command is headless. It invokes `codex exec` in read-only mode and
writes one file-local mini-tree per changed file to `analysis.json`; it does not
render the webview. The Tree view places those independent file mini-trees on
the canvas and renders their nodes as code diffs. Primary edges follow the
AI-authored review hierarchy. Technical cross-links remain available in the
JSON views without adding unlabeled edges to the canvas. Supporting and
mechanical sibling forests start in deterministic expandable groups so the
first pass stays focused on core and important runtime work.
