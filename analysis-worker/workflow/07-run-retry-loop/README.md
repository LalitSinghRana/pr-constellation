# 07 Run Retry Loop

`runReviewAnalysis` orchestrates the analysis workflow. It accepts an optional
executor, model, reasoning effort, event callback, run directory, and
`AbortSignal`.

The runner:

1. creates and validates `review-stacks.json`
2. generates File Trees and Section Trees, sharding large Review Stacks when
   necessary
3. derives section and file `changedLineIds`
4. assembles `pr-review-analysis/v1`
5. validates the candidate and optionally invokes the semantic judge
6. retries with targeted file repair when feedback identifies a safe scope
7. persists `analysis.json` and execution artifacts

When no executor is injected, the model id is looked up in the analysis-model
registry and the matching CLI driver is used.

Events use stable stage IDs such as `analysis.review-stacks`,
`analysis.attempt-1.generate-review-trees`, and
`analysis.attempt-1.evaluation.validate-candidate`.

Cancellation terminates the active process tree and prevents later stages from
starting. Generated raw outputs and prompts remain in the run directory for
debugging.
