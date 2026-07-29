# PR Graph Analysis Workflow

This workflow generates headless, file-local review trees for a PR. AI handles
semantic grouping and review explanations. Deterministic validation owns file
coverage, changed-line ownership, and tree structure. Failed candidates are
repaired by a later model attempt when the findings have a safe file-local
scope; the validator itself never edits them or substitutes a generic fallback.

All analysis implementation, contracts, and tests live in this directory.
Run its focused suite with:

```sh
pnpm check:analysis
```

## Output Shape

Current schema: `pr-graph-mini-trees/v2`.

```txt
files[]: exactly one entry per changed file
  miniTree.nodes[]: maximal cohesive sections partitioning that file's changed lines
  miniTree.reviewEdges[]: the ordered logical review hierarchy
  miniTree.relations[]: optional technical cross-links
```

Middle-tree and super-tree analysis are intentionally outside the current
pipeline.

Every file and mini-tree node has a `changeRole`. File summaries use
`important | supporting | mechanical`; mini-tree nodes additionally use
`core`:

```json
{
  "reviewClass": "core | important | supporting | mechanical",
  "changeRole": "runtime | test | storybook | snapshot | type | docs | config | dependency | generated | formatting | imports"
}
```

## Ordered Steps

1. [01 CLI Start](01-cli-start/README.md)
2. [02 Fetch PR](02-fetch-pr/README.md)
3. [03 Build Diff Inventory](03-build-diff-inventory/README.md)
4. [04 Generate Candidate Analysis](04-generate-candidate-analysis/README.md)
5. [05 Validate Candidate](05-validate-candidate/README.md)
6. [06 Judge Candidate](06-judge-candidate/README.md)
7. [07 Run Retry Loop](07-run-retry-loop/README.md)
8. [08 Final Output](08-final-output/README.md)

## Run Files

- `metadata.json`
- `diff.patch`
- `diff-inventory.json`
- `diff-summary.json`
- `mini-trees-prompt.md`
- `mini-trees.raw.json`
- `analysis.raw.json`
- `analysis.candidate.json`
- `judge.raw.json`
- `analysis.json`
- `judge.json`

## Guarantees

The deterministic validator enforces:

- every changed file appears exactly once and owns one mini-tree
- every added/deleted changed line belongs to exactly one mini-tree node
- each mini-tree node owns source-ordered changed spans from one hunk, may
  bridge unchanged context, and cannot skip an intervening changed line
- no mini-tree node contains a changed line from another file
- file `codeRefs` exactly match that file's changed lines
- each mini-tree has one root and every non-root node has one review parent
- sibling review edges use contiguous order values starting at zero
- review edges stay inside their file
- technical relations reference valid file-local nodes without affecting the
  review hierarchy
- `reviewClass` and `changeRole` use the approved values
- required titles, comments, and relation labels are non-empty strings

The judge then checks classification and hierarchy direction, whether node
boundaries preserve cohesive implementation sections, whether comments explain
What/Why instead of narrating How, and whether each file-local flow is
semantically useful.
Step 07 exposes validation and judging as one evaluation phase. Every
schema-usable candidate is judged even when deterministic validation fails, so
one retry receives the combined structural and semantic feedback. A run makes
at most three total attempts; later attempts repair only the affected
file-local mini-trees when the feedback can be scoped safely.
