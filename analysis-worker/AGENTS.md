# AGENTS.md — analysis-worker/

## Commands

Run from the **repository root** so artifacts land in `<repo>/.reviews/`:

```sh
node analysis-worker/bin/prc.js https://github.com/OWNER/REPO/pull/123
node analysis-worker/bin/prc.js analyze https://github.com/OWNER/REPO/pull/123
```

Focused tests:

```sh
node --test --test-concurrency=1 analysis-worker/workflow/tests/<file>.test.js
node --test --test-concurrency=1 analysis-worker/tests/benchmark-run.test.js
```

## Tech stack

- **Runtime:** Node 24 ESM
- **GitHub:** local `gh` authentication via `analysis-worker/workflow/02-fetch-pr/github.js`
- **AI providers:** Cursor Agent (`agent`), Claude (`claude`), Codex (`codex`) — configured in Settings
- **Validation:** deterministic schema + briefing checks in stage 05; semantic judge (stage 06) for offline benchmarking only

## Architecture

`analysis-worker/` owns the CLI, run coordinator, PR fetching, diff inventory,
prompts, schemas, validation, judging, retry orchestration, and analysis tests.

Numbered workflow stages under `analysis-worker/workflow/`:

```text
01-cli-start/
02-fetch-pr/           GitHub PR metadata + cumulative diff
03-build-diff-inventory/  diff parsing, hunk line IDs
04-generate-candidate-analysis/
  02-create-review-stacks/
  03-create-review-trees/
05-validate-candidate/  briefing-checks.js, validate-analysis.js
06-judge-candidate/     offline benchmark only (disabled in active pipeline)
07-run-retry-loop/      review-analysis.js, candidate generation, targeted repair
08-final-output/
```

Entry points:

- `analysis-worker/bin/prc.js` — CLI
- `analysis-worker/cli.js` — command routing (writes `.reviews` under `process.cwd()`)
- `analysis-worker/review-run.js` — run coordinator

The `analyze` command is headless: runs the review-tree workflow and writes
Section Trees to `analysis.json`; it does not render the review page.

### Run semantics (when driven by dashboard)

- Up to two different PRs run at once; analyses for the same PR remain serial
- Model-backed stages share a process-wide limit of three concurrent subprocesses
- File Tree and Section Tree generation/repair use the configured model's reasoning effort
- Deterministic validation is the active gate
- Cancel stops queued or running work without deleting completed history
- Successful run updates stable URL: `http://127.0.0.1:4397/reviews/<review-slug>/`

## Conventions

- Keep stage-specific code, prompts, schemas, tests, and documentation with their
  current stage directory.
- Do not bypass validated stage contracts or duplicate workflow logic in the server.
- Tests live in `analysis-worker/workflow/tests/` and `analysis-worker/tests/`.
- Use canonical vocabulary from `instructions/terminology.md`.
