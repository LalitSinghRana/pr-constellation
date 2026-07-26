# Step 04.2: Create All Mini-Trees

Create exactly one `files[]` entry for every changed file with added/deleted
changed lines in `diff-file-map.json`. Never omit a changed file and never emit
the same file twice. Use the exact `diff-file-map.files[].id` and `path` values.

Then create each file's `miniTree`.

## Mini-Tree Purpose

A mini-tree belongs to exactly one file. It explains only changes from that
file while keeping the whole file together for review. A mini-tree may never
reference a changed line from another file.

## Mini-Tree Flow Rules

- A mini-tree is a logical review flow, not top-to-bottom file order.
- Review causality is not declaration order, import order, compilation order, or
  dependency direction. Start from the behavior or reviewer question that
  motivated the file change, then point to contracts, helpers, setup, and styles
  that the core change required.
- The depth 0 root must use `reviewClass: core` and be the file's core
  meaningful change. It is the only node in the mini-tree allowed to use
  `core`.
  In a runtime file, this is usually the behavior/API/control-flow change, not
  imports, formatting, generated output, or other setup code near the top of
  the file.
- Edge direction means: the source change is the core/reason to review first;
  the target change was caused, enabled, required, or made necessary by that
  source change.
- Review priority is `core > important > supporting > mechanical`. Important,
  supporting, and mechanical nodes must appear downstream from the core root.
- Do not promote imports, formatting, generated output, or a secondary type
  declaration to `core` when the file contains the runtime behavior, test
  assertion, story scenario, or primary exported contract that motivated it.
- When equally important runtime and type nodes exist, the runtime behavior is
  the root. The contract follows because the behavior required it.
- In a component file, rendering, interaction, state, or control-flow behavior
  must precede prop declarations, dependencies, style declarations, and setup.
- In a test file, the assertion of the core behavior must precede shared render
  setup, fixtures, mocks, and harness code.
- In a story file, the visual scenarios must precede Storybook configuration
  and decorators.
- In a type-only file, root the complete exported contract or main domain
  concept before smaller supporting shapes merely declared earlier.
- Each file mini-tree must have exactly one depth 0 root. Every non-root
  mini-node must have exactly one parent edge.

## Mini-Tree Construction Rules

- Split a file into mini-nodes only when the file contains multiple useful
  review concepts.
- Every mini-node must own exactly one continuous range in exactly one hunk.
  List its changed line ids in source order, and require every adjacent pair to
  occupy consecutive positions in that hunk's complete `lines[]` array.
- An unchanged context line, another node's changed line, or a hunk boundary
  ends a range. Split separated ranges into separate mini-nodes even when they
  support the same semantic concept. Never place line 1 and line 20 in one
  mini-node.
- Assign every changed line id listed for the file in `diff-inventory.json` to
  exactly one mini-node.
- Treat `changedLineIds` as an ownership partition: the same changed line id
  must never appear in two mini-nodes, even when the concepts overlap.
- Every mini-node must own at least one changed line id. Never emit an empty
  `changedLineIds` array.
- Preserve every useful review concept even when doing so produces a large JSON
  response.
- Put imports, types, formatting, and generated churn in mechanical
  mini-nodes.
- Deterministically classify every non-root `imports`, `type`, `formatting`,
  and `generated` node as `mechanical`. The depth 0 node is always `core`,
  including the primary contract in a type-only file.
- Put runtime behavior in important or supporting mini-nodes.
- Every mini-node needs a `comment` explaining why the file-local change was
  needed or how it supports the file's main change.
- `miniTree.edges[]` connect mini-nodes within the same file only.
- Before returning the file, compare node depths with changed-line positions.
  If the result mostly follows ascending line numbers, rebuild it from review
  causality. Coincidental file-order trees are invalid.
- Before returning the full result, audit every file independently. The union
  of its mini-node `changedLineIds` must exactly equal that file's line ids,
  every intersection between two nodes must be empty, and no node may contain
  another file's line id.

Good mini-node examples:

- `core/runtime`: "Refocus hidden input when wrapper is pressed"
- `important/runtime`: "Render the new interactive content variants"
- `supporting/runtime`: "Keep hidden input addressable through a ref"
- `mechanical/imports`: "Import hooks and Pressable symbols"
- `mechanical/type`: "Declare the supporting content variant"
- `supporting/test`: "Cover the new validation path"

Bad mini-node examples:

- "Added 27 lines"
- "Updated file"
- A root node that exists only because it appears first in the file
- A test harness root pointing to the assertions it merely enables
- A props/types/setup root pointing to the runtime behavior that motivated it

## Stage Output

Return `pr-graph-mini-trees/v1` JSON containing:

- the overall review `intent`, `summary`, and `confidence`
- every changed file in `files[]`
- each file's complete logical `miniTree`

Do not create middle trees or a super-tree in this stage.
