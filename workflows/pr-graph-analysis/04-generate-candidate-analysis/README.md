# 04 Generate Candidate Analysis

This step asks the selected model to generate `pr-graph-mini-trees/v2` JSON
from PR metadata and one lossless structured diff.

The active generation contract has two prompt parts:

1. [`01-shared-contract/`](01-shared-contract/prompt.md) defines file ownership,
   changed-line coverage, classification, and output rules.
2. [`02-create-mini-trees/`](02-create-mini-trees/prompt.md) creates exactly one
   complete logical mini-tree for every changed file.

The mini-tree output is the complete candidate. The runner does not invoke the
middle-tree, super-tree, or v3 assembly directories while those hierarchy
levels are paused.

File, node, review-edge, and technical-relation comments explain What and Why;
the code attached to each node explains How. Prefer concise Markdown comments
and bullet lists for multiple distinct points, but length or formatting alone
never invalidates a useful explanation.

A semantic mini-node emits minimal inclusive `changedLineRanges`. Each range is
confined to one hunk, while one cohesive node may use multiple ranges or hunks.
The runner expands ranges into line ids and derives file ownership.
