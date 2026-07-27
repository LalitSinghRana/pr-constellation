# 04 Generate Candidate Analysis

This step asks Codex to generate `pr-graph-mini-trees/v2` JSON from the PR
metadata, diff file map, changed-line map, and cumulative patch.

The active generation contract has two prompt parts:

1. [`01-shared-contract/`](01-shared-contract/prompt.md) defines file ownership,
   changed-line coverage, classification, and output rules.
2. [`02-create-mini-trees/`](02-create-mini-trees/prompt.md) creates exactly one
   complete logical mini-tree for every changed file.

The mini-tree output is the complete candidate. The runner does not invoke the
middle-tree, super-tree, or v3 assembly directories while those hierarchy
levels are paused.

File, node, review-edge, and technical-relation comments explain What and Why;
the code attached to each node explains How. Comments may use Markdown
paragraphs and lists, and comments longer than 280 characters must contain at
least two bullet lines.
