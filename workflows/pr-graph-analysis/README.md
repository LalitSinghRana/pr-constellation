# PR Graph Analysis Workflow

This workflow generates headless, file-local review trees for a PR. AI handles
semantic grouping and review explanations. Deterministic validation owns file
coverage, changed-line ownership, and tree structure. Failed attempts are never
repaired or replaced with a generic fallback.

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
- each mini-tree node owns one continuous, source-ordered range in one hunk
- no mini-tree node contains a changed line from another file
- file `codeRefs` exactly match that file's changed lines
- each mini-tree has one root and every non-root node has one review parent
- sibling review edges use contiguous order values starting at zero
- review edges stay inside their file and flow toward
  supporting/mechanical work
- technical relations reference valid file-local nodes without affecting the
  review hierarchy
- every root is the tree's only `core` node
- review priority is `core > important > supporting > mechanical`
- imports, types, generated output, and formatting are deterministically
  mechanical outside the core root
- `reviewClass` and `changeRole` use the approved values

The judge then checks whether node boundaries preserve cohesive implementation
sections and whether each file-local flow is semantically useful.
Step 07 retries only after validation and judging have both run.
