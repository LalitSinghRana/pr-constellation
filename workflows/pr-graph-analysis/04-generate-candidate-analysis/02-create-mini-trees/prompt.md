# Step 04.2: Create All Mini-Trees

Create exactly one `files[]` entry for every changed file with added/deleted
changed lines in `diff-file-map.json`. Never omit a changed file and never emit
the same file twice. Use the exact `diff-file-map.files[].id` and `path` values.

Then create each file's `miniTree`.

## Mini-Tree Purpose

A mini-tree belongs to exactly one file. It explains only changes from that
file while keeping the whole file together for review. A mini-tree may never
reference a changed line from another file.

## Mini-Tree Review Hierarchy

- A mini-tree is a logical review flow, not top-to-bottom file order.
- `miniTree.reviewEdges[]` alone defines the ordered parent-child hierarchy a
  human follows through the file. It is not declaration order, import order,
  compilation order, or a dependency graph.
- Start from the behavior or reviewer question that motivated the file change.
  Give each downstream node the nearest review parent that explains why a human
  should inspect it next. Do not attach every helper, contract, style, and setup
  node directly to the root merely because the root technically uses it.
- The root must use `reviewClass: core` and be the file's core
  meaningful change. It is the only node in the mini-tree allowed to use
  `core`.
  In a runtime file, this is usually the behavior/API/control-flow change, not
  imports, formatting, generated output, or other setup code near the top of
  the file.
- A review-edge direction means: review the source question first, then inspect
  the target as part of that source's logical branch.
- Every review-edge comment must name what requirement or review relationship
  connects the two nodes and why the target belongs next under the source. Do
  not use generic sequencing text such as "review this next" or narrate how the
  target's code is implemented.
- Each parent's review edges must use unique contiguous `order` values starting
  at 0. Order siblings by review value and narrative flow, never by line number.
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
  and decorators. Keep related variant scenarios in a useful review sequence;
  attach shared renderers, frames, metadata, and decorators beneath the nearest
  scenario/setup branch instead of making every declaration a root child.
- In a fixture or mock file, start from the exported fixture set or meaningful
  variants a reviewer consumes. A private builder is supporting implementation,
  not the root merely because exported fixtures call it.
- In a type-only file, root the complete exported contract or main domain
  concept before smaller supporting shapes merely declared earlier.
- Each file mini-tree must have exactly one root with no incoming review edge.
  Every non-root mini-node must have exactly one parent review edge.
- Do not emit numeric node depths. `reviewEdges` are the sole hierarchy source;
  layout depth is derived deterministically from them.
- Direct children of the root must represent distinct reviewer questions.
  Prefer a few meaningful branches with deeper supporting structure over a
  shallow star of technical dependencies.
- Before returning any node with more than four direct review children, perform
  a reattachment audit. Setup should own derived analytics/defaults/contracts
  when that is the clearest walkthrough, and a complete style section should
  follow the render/state/interaction section it supports. Keep a child at the
  root only when it is genuinely an independent reviewer question.
- A supporting node belongs under the closest important or supporting branch
  whose behavior it explains. A mechanical node belongs under its closest
  consumer or setup branch.
- Keep a contiguous stylesheet declaration whole even when its individual
  members support different render branches. Attach that complete style node to
  the nearest shared render/state/interaction branch and use `relations` only
  for cross-links that add real review value.

## Cohesive Review Units

Partition each file into cohesive review units before assigning
`reviewClass`, `changeRole`, or review edges. Folding happens later in the UI
and must never influence this partition.

- A mini-node is a maximal contiguous section a reviewer needs to read together
  to understand one implementation phase. Prefer a complete section over
  several smaller nodes that force the reviewer to jump around for its gist.
- Split only at a stable lexical or implementation-phase boundary. Typical
  boundaries include imports, a complete type/contract declaration, component
  setup and hooks, a contiguous handler section, derived computations, a
  complete render phase, a complete stylesheet declaration, and an individual
  test or story.
- Never split one function or handler by its internal branches, switch cases,
  callbacks, or return paths.
- Never split one contiguous JSX/render phase by loading/empty states, image
  blocks, badge/laurel/title variants, conditional branches, or nested
  components. When an early render return is immediately followed by the main
  return with no intervening setup, computation, or handler section, keep the
  early return and main return in one render node.
- Never split one `StyleSheet.create`, CSS rule group, object literal, type,
  interface, test case, or story merely by its members, properties, assertions,
  variants, or child blocks.
- Keep a contiguous run of equivalent exported stories or fixtures together as
  one scenario/fixture-set section. Do not divide adjacent variant declarations
  into separate nodes solely because one variant is more important or will be
  folded differently.
- Keep a contiguous cluster of related hooks/state declarations together. Keep
  a contiguous cluster of action handlers together. Keep a contiguous cluster
  of derived values/computations together.
- Do not split a cohesive section to give secondary branches a lower
  `reviewClass`. Classify the whole section by its highest review significance.
  For example, a core render section remains one `core/runtime` node even when
  it contains supporting visual variants.
- Do not merge unrelated adjacent sections. An interface followed by component
  initialization, or handlers followed by rendering, remains separate even
  when every line is changed.
- Runtime constants/defaults and type/interface declarations are separate
  sections with different roles even when adjacent. Never hide runtime fallback
  behavior inside a `mechanical/type` node.
- Node size is not a reason to split. There is no target or maximum line count
  for a mini-node.

Required construction order:

1. Partition all changed lines into maximal cohesive sections.
2. Verify every boundary is a real lexical or implementation-phase boundary.
3. Assign one title, comment, `reviewClass`, and `changeRole` to each section.
4. Build the logical review hierarchy between those complete sections.
5. Audit the hierarchy as an edge list: exactly one `core` root has no incoming
   edge, every other node has exactly one incoming edge, every edge stays
   file-local, and each parent's sibling orders are `0..n-1`.

## Technical Relations

- `miniTree.relations[]` records optional technical relationships that are
  useful but must not control review depth, parentage, sibling order, or layout.
- Relation direction means the source technically uses, depends on, configures,
  or affects the target. State that relationship precisely in `relation` and
  explain what the secondary relationship means and why it is useful to the
  reviewer in `comment`. The code already shows how the dependency is wired.
- Relations may cross review branches and may give a node multiple incoming
  technical links. They still remain file-local and may not point to themselves
  or unknown nodes.
- Do not duplicate every review edge as a technical relation. Emit only
  cross-links that help a reviewer understand shared dependencies or effects.
- Return an empty `relations` array when no secondary relationship adds value.

## Mini-Tree Construction Rules

- Split a file into mini-nodes only when it contains multiple cohesive review
  sections.
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
- Describe internal variants and details in the node title/comment rather than
  extracting them from their cohesive section solely to create more concepts.
- Put imports, types, formatting, and generated churn in mechanical
  mini-nodes.
- Deterministically classify every non-root `imports`, `type`, `formatting`,
  and `generated` node as `mechanical`. The root node is always `core`,
  including the primary contract in a type-only file.
- Put runtime behavior in important or supporting mini-nodes.
- `important` means the reviewer should see that node on the first pass.
  Secondary states, decorative variants, style implementation, analytics
  wiring, fallback values, and setup are normally `supporting` unless the PR's
  stated intent centers that behavior or they are inseparable parts of a
  higher-priority cohesive section.
- Adding a new component does not make every JSX branch independently
  important. Keep image blocks, badge/laurel/plain-title variants, and
  loading/empty placeholders inside their complete render section when they are
  contiguous. Do not extract them as supporting nodes merely for folding.
  Interaction dispatch, consequential control flow, and the primary behavioral
  contract are stronger candidates for separate important sections.
- Audit the default first-pass projection containing only `core` and
  `important/runtime` nodes. It should normally expose no more than three
  sibling questions under one parent. Reclassify secondary runtime details as
  supporting rather than overwhelming the first pass.
- `supporting` means the node can be folded initially and inspected when the
  reviewer opens supporting work. Do not label every runtime branch important
  merely because it executes at runtime.
- Every mini-node needs a `comment` explaining what the cohesive section changes
  or proves and why that file-local change is needed or consequential. The code
  in the node already explains how it works.
- Do not force comments to be concise. Use Markdown bullet points when a node
  has multiple distinct effects, reasons, constraints, or reviewer checks. A
  comment longer than 280 characters must contain at least two Markdown bullet
  lines. Never discard useful detail merely to stay under that threshold.
- `miniTree.reviewEdges[]` and `miniTree.relations[]` connect mini-nodes within
  the same file only.
- Before returning the file, compare hierarchy order with changed-line
  positions. If the result mostly follows ascending line numbers, rebuild it
  from review causality. Coincidental file-order trees are invalid.
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
- Separate badge, laurel, title, and loading nodes cut out of one contiguous
  render phase
- Separate style nodes cut out of one `StyleSheet.create` declaration
- Separate nodes for switch cases or assertions inside one handler or test
- A root node that exists only because it appears first in the file
- A test harness root pointing to the assertions it merely enables
- A props/types/setup root pointing to the runtime behavior that motivated it

## Stage Output

Return `pr-graph-mini-trees/v2` JSON containing:

- the overall review `intent`, `summary`, and `confidence`
- every changed file in `files[]`
- each file's complete logical `miniTree`

Do not create middle trees or a super-tree in this stage.
