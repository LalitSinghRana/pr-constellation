# PR Review Analysis Workflow

This workflow turns a pull-request diff into a reviewer-oriented hierarchy.

The stable domain terms are:

- **Review Stack**: a coherent group of changed files
- **Stack Tree**: the ordered parent-child review path across a Review Stack
- **File Tree**: the ordered parent-child review path within one file
- **review section**: a cohesive changed-code unit in a File Tree
- **branch**: an ordered parent-child connection in either tree
- **review priority**: `primary`, `secondary`, or `skim`
- **change kind**: the responsibility changed by a file or section
- **explanation**: what changed or is related and why it matters

The final `pr-review-analysis/v1` shape is:

```text
reviewStacks[]
  id, title, explanation, fileIds
  stackTree.branches[]
files[]
  id, path, reviewPriority, changeKind, explanation, changedLineIds
  fileTree.sections[]
  fileTree.branches[]
```

Workflow stages:

1. accept CLI input
2. fetch PR metadata and diff
3. build stable file, hunk, and changed-line IDs
4. generate Review Stacks, File Trees, and Stack Trees
5. validate ownership and tree invariants
6. optionally judge semantic review usefulness
7. retry generation or targeted repair
8. persist `analysis.json`

Run the workflow checks from the repository root with `pnpm check:analysis`.
