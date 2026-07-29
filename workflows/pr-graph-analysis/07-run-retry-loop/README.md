# 07 Run Retry Loop

`codex-agent.js` runs at most three total attempts.

The first attempt generates all file mini-trees and persists the exact AI
output. Every schema-usable candidate then enters one `Evaluation` stage:

1. Pure deterministic validation runs first.
2. The AI semantic judge runs second with the validation report, including when
   structural validation failed.
3. The runner aggregates both reports before it decides whether the candidate
   passes or proceeds to the next available attempt.

On attempts two and three, the runner resolves the combined findings to
affected inventory file, node, hunk, and changed-line ids. When that scope is
safe, Codex receives:

- the current complete candidate
- the combined validation and judge feedback
- only the affected file/hunk source input

Codex returns complete replacement entries only for those files. The runner
merges them into the prior candidate without changing unaffected files, then
revalidates and rejudges the complete merged candidate. If no concrete repair
scope can be resolved, the runner falls back to a complete regeneration with
the combined feedback. There is no generic fallback analysis.

## Execution configuration and usage

`runCodexGraphAnalysis` accepts a model executor, `model`, and
`reasoningEffort`. The dashboard selects either the Codex executor or the
Claude executor once per run, so every generation, repair, and judge call uses
the same provider, model, and effort.

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
