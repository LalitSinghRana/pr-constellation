# Step 04.5: Assemble Final JSON

The runner assembles the final `pr-graph-analysis/v3` JSON from the three
persisted AI stage outputs. Assembly attaches each complete middle tree to its
matching super-tree id and does not repair, reorder, merge, split, or rewrite
AI-authored nodes or edges.

## Final Audit

Before returning JSON, audit coverage and hierarchy:

- every file has at least one useful mini-node
- every file appears exactly once in `files[]`
- every file belongs to exactly one middle tree-node
- every tree-node belongs to exactly one super-node tree
- every file mini-tree, every middle tree, and the super-tree have exactly one
  depth 0 root
- every tree root starts from the highest-priority reviewClass present in that
  tree
- equally important runtime work starts before type, setup, helper, style, or
  registration work
- mini-tree roots represent behavior/assertions/scenarios/main contracts rather
  than the first changed lines in each file
- every multi-file middle tree is an explicit connected graph of tree-nodes
  containing complete file mini-trees
- edges never imply supporting/mechanical work caused the important/core change
- file `codeRefs.fileIds` contains its own file id
- tree-node `codeRefs.fileIds` is the files referenced by that tree-node
- super-node `codeRefs.fileIds` is the union of its tree-node file ids
- every mini-node has at least one changed line id
- every changed line id appears in exactly one mini-node
- file `codeRefs.changedLineIds` is the exact union of its mini-node line ids
- tree-node `codeRefs.changedLineIds` is the exact union of its referenced
  files' line ids
- super-node `codeRefs.changedLineIds` is the exact union of its middle tree's
  line ids
- no semantic node, edge, line id, or hierarchy level was omitted for brevity

After assembly, pass the unchanged candidate to step 05 validation and then
step 06 judging.
