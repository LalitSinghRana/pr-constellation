# Benchmark Dashboard

The benchmark dashboard is a local, single-user control plane for generating
and comparing PR review graphs.

Start it with:

```sh
pnpm web
```

Then open:

```text
http://127.0.0.1:4173/reviews/
```

## Run semantics

- Starting an analysis selects one model and creates one run. Mini-tree
  generation and targeted repair use the provider's highest configured effort
  (`xhigh` for Codex and `max` for Claude). Deterministic validation is the
  active gate; the semantic judge is retained but disabled.
- The first run for a PR fetches its metadata and cumulative diff through the
  locally authenticated `gh` CLI. Base and head refs are checked again after
  the diff fetch; if either moved, the snapshot is retried instead of storing
  mismatched metadata and code.
- **Run again** and submitting the same PR URL use the latest saved input by
  default. This freezes the exact metadata, base/head commit SHAs, and diff
  while exercising the current local analysis code.
- **Refresh from GitHub** explicitly fetches the PR again before analysis.
- **Cancel run** stops the active GitHub or model process tree.
- Every successful graph opens in a new browser tab from its run-specific URL.
  The stable PR URL continues to point at the latest rendered graph.
- Completed runs can be deleted individually. Deletion requires confirmation
  and removes the corresponding local run directory and generated graph.

## Timings

Each run records a total duration plus nested stages for:

1. input fetch or frozen-input reuse
2. GitHub authentication, consistent-snapshot attempts, metadata, diff fetch,
   and ref verification
3. diff inventory parsing and summary construction
4. input persistence
5. each analysis attempt, capped at three total attempts
6. full mini-tree generation or targeted file-local repair
7. deterministic validation
8. graph build and HTML persistence

The dashboard shows active progress, a nested timing waterfall, reasoning
effort, retry attempts, and the delta from the preceding successful comparable
run. A refreshed or otherwise different PR snapshot starts a new baseline
instead of producing a misleading speed comparison.

Timing is the primary benchmark signal. Immediately before a queued run starts,
its metadata records the local Git commit and a code fingerprint that includes
uncommitted changes. Each completed input snapshot also gets a deterministic
fingerprint derived from its canonical PR metadata and exact diff. Run metadata
also records its provider, selected model, actual reasoning effort, PR size,
and commit SHAs. When the model CLI reports usage,
input, cached-input, output, and total token counts are persisted with the run,
including when the analysis ultimately fails or is canceled after reporting
usage.

Run headers also show an API-equivalent USD estimate when the selected model
has a known public token rate. It prices uncached input, cached input, and
output separately from the persisted usage. The value is labeled as an
estimate because Codex and Claude subscription billing can differ from API
list pricing; unsupported models and runs without token telemetry show `—`.

The dashboard discovers selectable models from visible entries in the local
Codex model cache and includes the effective model from Codex configuration. If
an authenticated Claude Code CLI is installed, it also offers the pinned
`claude-opus-4-6[1m]` baseline with Claude's native effort levels. Pinning the
full model ID keeps historical benchmark comparisons stable when Claude's
moving `opus` alias changes.
`PRC_CODEX_MODELS`, `PRC_CODEX_MODEL`, and
`PRC_CODEX_REASONING_EFFORTS` can override discovery for repeatable local
experiments. `PRC_CLAUDE_MODELS`, `PRC_CLAUDE_MODEL`, and
`PRC_CLAUDE_REASONING_EFFORTS` provide the corresponding Claude overrides.

## Local API

`GET /api/dashboard` returns saved PRs, queue state, and:

```json
{
  "configuration": {
    "defaultModel": "gpt-5.5",
    "models": ["gpt-5.5", "claude-opus-4-6[1m]"],
    "modelProviders": {
      "gpt-5.5": "codex",
      "claude-opus-4-6[1m]": "claude"
    },
    "reasoningEfforts": ["low", "medium", "high", "xhigh"],
    "modelReasoningEfforts": {
      "gpt-5.5": ["low", "medium", "high", "xhigh"],
      "claude-opus-4-6[1m]": ["low", "medium", "high", "max"]
    }
  }
}
```

`POST /api/runs` accepts `{ "prUrl": "...", "model": "...", "refresh": false }`
and returns the queued run. `POST
/api/runs/<review-slug>/<run-id>/rerun` accepts `{ "model": "..." }` and returns
one queued run against the saved input.

`POST /api/runs/<review-slug>/<run-id>/cancel` cancels a run. `DELETE
/api/runs/<review-slug>/<run-id>` removes one completed run. Active history
must be canceled before deletion.

## Persistence

All state is stored under the gitignored `.reviews/` directory:

```text
.reviews/
  index.html
  <review-slug>/
    index.html
    <run-id>/
      run.json
      timings.json
      metadata.json
      diff.patch
      diff-inventory.json
      diff-summary.json
      analysis.json
      judge.json
      index.html
```

`run.json` contains lifecycle, source, code-version, PR, graph, and summary
metadata. `timings.json` contains the durable stage hierarchy and raw timing
events. State updates use temporary files followed by atomic renames.

History survives server shutdown because the dashboard rebuilds its view from
these files. A run that was still `queued` or `running` when the server stopped
is marked `interrupted` on the next start; completed history and frozen inputs
remain available. User cancellation is persisted separately as `canceled`;
available partial input, timing, and token-usage data remain attached to that
run.

Generated review data is intentionally local and gitignored. Back up or copy
`.reviews/` if the benchmark history must move to another machine.
