# Step 04.3: Create All Middle Trees From The Mini-Trees

The input includes the exact `pr-graph-mini-trees/v1` JSON produced by the
previous AI stage. Group those complete file mini-trees into
`middleTrees[].tree.nodes[]`.

## Middle Tree Purpose

A middle tree will become exactly one super-node in the next stage. It explains
how related files work together. It is a graph whose nodes reference complete
file mini-trees; it is not one wrapper around one mini-tree.

## Middle Tree Flow Rules

- A middle tree is a logical review flow, not alphabetical file order, directory
  order, or raw diff order.
- Review causality is not import or dependency direction. The product behavior
  that motivated the PR comes before types, analytics registration, helpers,
  mocks, and other files required to implement or verify it.
- The depth 0 root must be the core file or file group for that top-level
  review group.
- Edge direction means: the source file/group is the core/reason to review
  first; the target file/group was caused, enabled, required, or made necessary
  by that source.
- Do not make tests, stories, snapshots, generated output, config, formatting,
  imports, or other mechanical/support-only work the depth 0 root when the same
  middle tree contains important runtime/type/API behavior.
- If a middle tree has important tree-nodes, at least one important tree-node
  must be the depth 0 root. Supporting and mechanical tree-nodes should normally
  appear downstream from the important root.
- When equally important runtime and type tree-nodes exist, the runtime
  implementation must be the depth 0 root.
- Each middle tree must have exactly one depth 0 root. Every non-root tree-node
  must have exactly one parent edge.

## Middle Tree Construction Rules

- Every file mini-tree from the previous stage must belong to exactly one
  middle tree-node.
- Prefer one tree-node per complete file mini-tree so file-to-file review flow
  remains explicit. Combine multiple files only when they are inseparable as
  one review concept.
- A tree-node may reference one file or multiple files when those files should
  be reviewed together as one conceptual unit.
- If a file has important and mechanical mini-nodes, keep the file together in
  one tree-node. Do not split the file across tree-nodes.
- A tree-node `comment` must explain why these files belong together and why the
  node sits at this point in the middle tree.
- Choose the tree-node's `reviewClass` and `changeRole` from its dominant
  review purpose.
- `tree.edges[]` connect tree-node ids only and must explain why the target file
  or file-group change was caused, enabled, or required by the source.
- Related file mini-trees must share a multi-node middle tree and be connected
  into a real rooted graph. Do not emit one middle tree per file when those
  files implement, support, demonstrate, or verify the same change.
- A one-node middle tree is allowed only for a genuinely isolated file change
  that has no causal review relationship with any other changed file.

For a component split across component, hook, helper, constants, styles, tests,
or stories, group files into tree-nodes that match how a human should review the
conceptual unit.

If the PR only has one logical file group, a super-node can contain a one-node
middle tree with no tree edges.

## Stage Output

Return `pr-graph-middle-trees/v1` JSON with `middleTrees[]`.

Each middle tree contains its final title, classification, role, comment,
confidence, aggregate `codeRefs`, and a connected `tree.nodes[]` /
`tree.edges[]` graph. Do not create super-tree depths or super-tree edges in
this stage.
