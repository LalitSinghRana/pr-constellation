# PR Review Analysis Workflow

This workflow turns a pull-request diff into a reviewer-oriented hierarchy.

The stable domain terms are:

- **Review Stack**: a coherent group of changed files
- **File Tree**: the ordered parent-child review path across a Review Stack
- **Section Tree**: the ordered parent-child review path within one file
- **review section**: a cohesive changed-code unit in a Section Tree
- **branch**: an ordered parent-child connection in either tree
- **review priority**: `primary`, `secondary`, or `skim`
- **change kind**: the responsibility changed by a file or section
- **explanation**: reviewer briefing in plain Markdown; consequence first, 2–4 sentences or bullets; title-plus (must add information the title cannot carry alone); Review Stack = shared outcome; file/section/branch = why this piece matters for that outcome
- **review walk ladders**: shared decision ladders for stack split, file-first order, and mini-node-first order; titles and intent/summary name reviewer questions and outcomes, not code verbs or changelogs

The final `pr-review-analysis/v1` shape is:

```text
reviewStacks[]
  id, title, explanation, fileIds
  fileTree.branches[]
files[]
  id, path, reviewPriority, changeKind, explanation, changedLineIds
  sectionTree.sections[]
  sectionTree.branches[]
```

Workflow stages:

1. accept CLI input
2. fetch PR metadata and diff
3. build stable file, hunk, and changed-line IDs
4. generate Review Stacks, File Trees, and Section Trees
5. validate ownership and tree invariants
6. optionally judge semantic review usefulness
7. retry generation or targeted repair
8. persist `analysis.json`

Run the repository tests from the repository root with `pnpm test`.
