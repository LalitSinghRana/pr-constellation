# 04 Generate Candidate Analysis

The AI generation contract has three focused inputs:

1. `01-shared-contract/` defines shared File Tree and Stack Tree semantics.
2. `02-create-review-stacks/` groups changed files into Review Stacks.
3. `03-create-review-trees/` creates one File Tree per file and one Stack Tree
   per Review Stack.

The runner derives changed-line ownership and assembles the final
`pr-review-analysis/v1` document. The final document embeds each Stack Tree in
its Review Stack; it has no parallel hierarchy representation.
