# Step 04.4: Create The Super-Tree From The Middle Trees

The input includes the exact `pr-graph-middle-trees/v1` JSON produced by the
previous AI stage. Order those complete middle trees as top-level
`superTree.nodes[]` and connect them with `superTree.edges[]`.

## Super-Tree Purpose

The super-tree connects top-level review groups into the final PR walkthrough.

## Super-Tree Flow Rules

- The super-tree is a logical review flow, not file order, package order,
  commit order, or raw diff order.
- Review causality is not code dependency direction. Start from the PR's core
  product behavior, then move to contracts/helpers it required and verification
  work caused by that behavior.
- Exactly one super-node must have `depth: 0`.
- The depth 0 root must be the PR's core review group when one exists.
- Edge direction means: the source review group is the core/reason to review
  first; the target group was caused, enabled, required, or made necessary by
  that source.
- Do not make tests, stories, snapshots, generated output, config, formatting,
  imports, or other mechanical/support-only work the depth 0 root when the PR
  contains important runtime/type/API behavior.
- If the super-tree has important super-nodes, at least one important super-node
  must be the depth 0 root. Supporting and mechanical super-nodes should
  normally appear downstream from the important root.
- When equally important runtime and type groups exist, the runtime group must
  be the root.
- Every other super-node must have exactly one incoming parent edge.
- Every super-edge must go from `depth N` to `depth N + 1`.
- Never create same-level, backward, skipped-level, cyclic, or loopback edges.

## Super-Tree Construction Rules

- `superTree.edges[]` connect super-node ids only.
- Emit exactly one `superTree.nodes[]` reference for every input middle tree.
- Every super-node reference must use the exact corresponding
  `middleTrees[].id`; do not rename, merge, split, or omit middle trees.
- If multiple files are core, put them in one minimal depth 0 super-node whose
  middle tree can still show file-level flow.
- Do not force fake levels. If a small PR has one super-node,
  `superTree.edges[]` can be empty.
- A super-node `comment` must explain why this top-level group exists and why it
  sits at this point in the review flow.

Do not invent files, APIs, or behavior that is not supported by the PR data.
When uncertain, lower confidence and state uncertainty in the relevant comment.

## Stage Output

Return `pr-graph-super-tree/v1` JSON. Each `superTree.nodes[]` item contains
only an exact middle-tree `id` and its final `depth`. The runner will attach the
complete unchanged middle tree to that node. Return causal super-tree edges
between those exact ids.
