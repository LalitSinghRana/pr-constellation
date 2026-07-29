# 07 Run Retry Loop

`codex-agent.js` runs at most three total attempts.

The first attempt generates all file mini-trees and persists the exact AI
output. Every candidate then enters one `Evaluation` stage:

1. Pure deterministic validation runs first.
2. The semantic judge stage is recorded as skipped; its implementation remains
   available for offline benchmarking.
3. Deterministic validation decides whether the candidate passes or proceeds
   to the next available attempt.

On attempts two and three, the runner resolves validation findings to
affected inventory file, node, hunk, and changed-line ids. When that scope is
safe, Codex receives:

- the current complete candidate
- the deterministic validation feedback
- only the affected file/hunk source input

Codex returns complete replacement entries only for those files. The runner
merges them into the prior candidate without changing unaffected files, then
revalidates the complete merged candidate. If no concrete repair
scope can be resolved, the runner falls back to a complete regeneration with
the validation feedback. There is no generic fallback analysis.

## Execution configuration and usage

`runCodexGraphAnalysis` accepts a model executor, `model`, and generation
`reasoningEffort`. The dashboard selects either the Codex executor or the
Claude executor once per run. Generation and repair use the highest configured
provider effort (`xhigh` for Codex or `max` for Claude). The retained semantic
judge remains configured for `high` when explicitly re-enabled.

Codex uses `--model` and `--config model_reasoning_effort=...`. Claude uses its
authenticated local CLI in non-interactive, tool-free, non-persistent mode with
`--model`, `--effort`, and `--json-schema`. Claude receives a structurally
equivalent schema with unsupported numeric and length constraints removed; the
existing deterministic validation still enforces those hard rules on the
returned candidate.

Codex `turn.completed` events and Claude stream result events are normalized
into:

```json
{
  "inputTokens": 0,
  "cachedInputTokens": 0,
  "outputTokens": 0,
  "totalTokens": 0
}
```

The final result exposes this object as `usage`; timing events also report
per-stage token deltas. A terminal error carries the usage accumulated before
failure. `totalTokens` is input plus output tokens; cached input is already a
subset of input and is not added again.

`runCodexGraphAnalysis` also accepts an `AbortSignal`. Cancellation terminates
the active model process tree, waits for it to exit, records open timing stages
as `canceled`, preserves usage reported before the abort, and stops without
consuming another analysis attempt.

The runner does not invoke middle-tree or super-tree generation.
