---
name: agentic-workflow
description: "Use when the user invokes @agentic-workflow or asks for an iterative agentic implementation loop for this PR Review Cockpit web project: plan, implement, verify, inspect the generated webview with Agent Browser, fix root causes, and repeat until accepted or honestly blocked."
---

# Agentic Workflow

Run a bounded implement -> verify -> browser-inspect -> fix loop for this repo.

This skill is for development velocity and quality. It is not part of the PR
review product runtime.

## Required Reads

Read these resources before making task edits:

1. `references/loop.md`
2. `references/gates.md`
3. `references/browser-review.md` when the task affects generated HTML, React
   Flow, styling, layout, or browser behavior.

## Core Loop

1. Understand the user's task and current git status.
2. Run baseline verification before edits when practical:

   ```sh
   .codex/skills/agentic-workflow/scripts/verify.sh
   ```

3. Make the smallest coherent change.
4. Run full verification:

   ```sh
   .codex/skills/agentic-workflow/scripts/verify.sh
   ```

5. If the task affects UI or generated HTML, render a real review page and use
   Agent Browser to inspect it:

   ```sh
   pnpm web <run-dir>
   pnpm ab -- open --enable react-devtools http://127.0.0.1:4173/reviews/<review-slug>/<run-id>/
   pnpm ab -- snapshot
   pnpm ab -- errors
   pnpm ab -- console
   pnpm ab -- screenshot .context/agent-browser/current.png
   pnpm ab -- close --all
   ```

6. Diagnose root causes, fix, and repeat until accepted or blocked.
7. Stop after 5 attempts and report what still fails.

## Live Review URLs

Always give the user a live localhost URL for generated review pages, not a
`file://` URL, unless they explicitly ask for the file path.

Use the fixed local server port:

```sh
pnpm web <run-dir>
```

The canonical URL shape is:

```text
http://127.0.0.1:4173/reviews/<review-slug>/<run-id>/
```

Keep all review revisions under the same server and port. A new generated
revision gets a new `<run-id>` subpath under the same `<review-slug>`. If port
`4173` is already occupied, reuse that server if it is serving this workspace,
or stop it before starting a new one; do not switch to another port.

## Acceptance

Accepted means:

- `verify.sh` exits 0.
- No blocker or major self-review findings remain.
- For UI work, Agent Browser inspection shows the relevant UI exists, no page
  errors are present, and the screenshot does not show obvious layout breakage.

Do not claim success from reading code alone.

## Report

At handoff, include:

- Files changed.
- Attempts used.
- Verification commands and results.
- Agent Browser signals when UI was inspected.
- The live `http://127.0.0.1:4173/reviews/<review-slug>/<run-id>/` URL for the
  generated review when applicable.
- Any remaining risk or skipped validation.
