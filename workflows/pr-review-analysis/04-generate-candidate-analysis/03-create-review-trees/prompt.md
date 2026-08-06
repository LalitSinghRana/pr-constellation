# Step 04.3: Create Review Trees

Create exactly one `files[]` entry for every changed file with added/deleted
lines in the structured diff. Never omit a changed file and never emit the same
file twice. Use the exact structured-diff file `id` and `path` values.

Then create each file's `fileTree`.

## File Tree Purpose

A file tree belongs to exactly one file. It explains only changes from that
file while keeping the whole file together for review. A file tree may never
reference a changed line from another file.

## File Tree Review Hierarchy

- A file tree is a logical review flow, not top-to-bottom file order.
- `fileTree.branches[]` alone defines the ordered parent-child hierarchy a
  human follows through the file. It is not declaration order, import order,
  compilation order, or a dependency structure.
- Start from the behavior or reviewer question that motivated the file change.
  Give each downstream section the nearest review parent that explains why a human
  should inspect it next. Do not attach every helper, contract, style, and setup
  section directly to the root merely because the root technically uses it.
- The root is whichever section has no incoming review branch; it is not marked by
  `reviewPriority`. Choose the file's most meaningful change as the root — in a
  runtime file, this is usually the behavior/API/control-flow change, not
  imports, formatting, generated output, or other setup code near the top of
  the file.
- A tree branch direction means: review the parent question first, then inspect
  the child as part of that parent's logical branch.
- Every tree branch explanation must name what requirement or review relationship
  connects the two sections and why the child belongs under the parent. Do
  not use generic sequencing text such as "review this next" or narrate how the
  target's code is implemented.
- Each parent's tree branches must use unique contiguous `order` values starting
  at 0. Order siblings by review value and narrative flow, never by line number.
- Review priority is `primary > secondary > skim`. Order sections by
  that priority and by narrative flow, not by which one happens to be the root.
- Do not make imports, formatting, generated output, or a secondary type
  declaration the root when the file contains the runtime behavior, test
  assertion, story scenario, or primary exported contract that motivated it.
- When equally primary runtime and type sections exist, the runtime behavior is
  the root. The contract follows because the behavior required it.
- In a component file, rendering, interaction, state, or control-flow behavior
  must precede prop declarations, dependencies, style declarations, and setup.
- In a test file, the assertion of the primary behavior must precede shared render
  setup, fixtures, mocks, and harness code.
- In a story file, the visual scenarios must precede Storybook configuration
  and decorators. Keep related variant scenarios in a useful review sequence;
  attach shared renderers, frames, metadata, and decorators beneath the nearest
  scenario/setup branch instead of making every declaration a root child.
- In a fixture or mock file, start from the exported fixture set or meaningful
  variants a reviewer consumes. A private builder is secondary implementation,
  not the root merely because exported fixtures call it.
- In a type-only file, root the complete exported contract or main domain
  concept before smaller secondary shapes merely declared earlier.
- Each File Tree must have exactly one root with no incoming branch.
  Every non-root review section must have exactly one parent review branch.
- Do not emit numeric section depths. `branches` are the sole hierarchy source;
  layout depth is derived deterministically from them.
- Direct children of the root must represent distinct reviewer questions.
  Prefer a few meaningful branches with deeper secondary structure over a
  shallow star of technical dependencies.
- Before returning any section with more than four direct review children, perform
  a reattachment audit. Setup should own derived analytics/defaults/contracts
  when that is the clearest walkthrough, and a complete style section should
  follow the render/state/interaction section it supports. Keep a child at the
  root only when it is genuinely an independent reviewer question.
- A secondary section belongs under the closest primary or secondary branch
  whose behavior it explains. A skim section belongs under its closest
  consumer or setup branch.
- Keep a contiguous stylesheet declaration whole even when its individual
  members support different render branches. Attach that complete style section
  to the nearest shared render/state/interaction branch.

## Cohesive Review Units

Partition each file into cohesive review units before assigning
`reviewPriority`, `changeKind`, or tree branches. Folding happens later in the UI
and must never influence this partition.

- A review section is a maximal contiguous section a reviewer needs to read together
  to understand one implementation phase. Prefer a complete section over
  several smaller sections that force the reviewer to jump around for its gist.
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
  early return and main return in one render section.
- Never split one `StyleSheet.create`, CSS rule group, object literal, type,
  interface, test case, or story merely by its members, properties, assertions,
  variants, or child blocks.
- Keep a contiguous run of equivalent exported stories or fixtures together as
  one scenario/fixture-set section. Do not divide adjacent variant declarations
  into separate sections solely because one variant is more primary or will be
  folded differently.
- Keep a contiguous cluster of related hooks/state declarations together. Keep
  a contiguous cluster of action handlers together. Keep a contiguous cluster
  of derived values/computations together.
- Do not split a cohesive section to give secondary branches a lower
  `reviewPriority`. Classify the whole section by its highest review significance.
  For example, a primary render section remains one `primary/runtime`
  section even when it contains secondary visual variants.
- Do not merge unrelated adjacent sections. An interface followed by component
  initialization, or handlers followed by rendering, remains separate even
  when every line is changed.
- Runtime constants/defaults and type/interface declarations are separate
  sections with different roles even when adjacent. Never hide runtime fallback
  behavior inside a `skim/type` section.
- Section size is not a reason to split. There is no target or maximum line count
  for a review section.

Required construction order:

1. Partition all changed lines into maximal cohesive sections.
2. Verify every boundary is a real lexical or implementation-phase boundary.
3. Assign one title, explanation, `reviewPriority`, and `changeKind` to each section.
4. Build the logical review hierarchy between those complete sections.
5. Audit the hierarchy as a branch list: exactly one root has no incoming branch,
   every other section has exactly one incoming branch, every branch stays
   file-local, and each parent's sibling orders are `0..n-1`.

## File Tree Construction Rules

- Split a file into review sections only when it contains multiple cohesive review
  sections.
- After partitioning cohesive sections, encode each section with the minimal
  source-ordered `changedLineRanges` required by the shared ownership contract.
- Describe internal variants and details in the section title/explanation rather than
  extracting them from their cohesive section solely to create more concepts.
- Put imports, formatting, and generated churn in skim review sections.
- Classify type sections by review value. Primary behavioral or public
  contracts can be `primary/type`; routine secondary declarations can be
  `secondary/type` or `skim/type`.
- Put runtime behavior in primary or secondary review sections.
- `primary` means the reviewer should see that section on the first pass.
  Secondary states, decorative variants, style implementation, analytics
  wiring, fallback values, and setup are normally `secondary` unless the PR's
  stated intent centers that behavior or they are inseparable parts of a
  higher-priority cohesive section.
- Adding a new component does not make every JSX branch independently
  primary. Keep image blocks, badge/laurel/plain-title variants, and
  loading/empty placeholders inside their complete render section when they are
  contiguous. Do not extract them as secondary sections merely for folding.
  Interaction dispatch, consequential control flow, and the primary behavioral
  contract are stronger candidates for separate primary sections.
- Audit the default first-pass projection containing the root and other
  `primary/runtime` sections. It should normally expose no more than three
  sibling questions under one parent. Reclassify secondary runtime details as
  secondary rather than overwhelming the first pass.
- `secondary` means the section can be folded initially and inspected when the
  reviewer opens secondary work. Do not label every runtime branch primary
  merely because it executes at runtime.
- `fileTree.branches[]` connects Review Sections within the same file only.
- Before returning the file, compare hierarchy order with changed-line
  positions. If the result mostly follows ascending line numbers, rebuild it
  from review causality. Coincidental file-order trees are invalid.
- Before returning the full result, audit every file independently. The union
  of its expanded review section ranges must exactly equal that file's changed lines,
  every intersection between two sections must be empty, and no section may contain
  another file's range.

Good review section examples:

- `primary/runtime`: "Refocus hidden input when wrapper is pressed" (the root)
- `primary/runtime`: "Render the new interactive content variants"
- `secondary/runtime`: "Keep hidden input addressable through a ref"
- `skim/imports`: "Import hooks and Pressable symbols"
- `skim/type`: "Declare the secondary content variant"
- `secondary/test`: "Cover the new validation path"

Bad review section examples:

- "Added 27 lines"
- "Updated file"
- Separate badge, laurel, title, and loading sections cut out of one contiguous
  render phase
- Separate style sections cut out of one `StyleSheet.create` declaration
- Separate sections for switch cases or assertions inside one handler or test
- A root section that exists only because it appears first in the file
- A test harness root pointing to the assertions it merely enables
- A props/types/setup root pointing to the runtime behavior that motivated it

## Stack Tree

Beyond each file's own File Tree, create the Review Stack's `stackTree`. Its
`branches[]` define the order in which a reviewer should open the stack's files.

- The parent is the reason to review first; the child was caused, enabled,
  required, or made necessary by that parent. This is review causality, not
  import direction — a component comes before the types, helpers, mocks, and
  tests that support it, not after, even when the component imports them.
- Do not order by file path, directory, or diff order. Coincidental file-order
  trees are invalid, just as they are for a File Tree.
- Every file in this stack appears exactly once as a branch `childId`, except
  the root, which never appears as a `childId`. The root is the file whose change is the
  reason the rest of the stack exists — usually the highest-priority file
  present (`primary` before `secondary` before `skim`; `runtime`
  before `test`, `type`, and other secondary roles). A `test` or `snapshot`
  file must not be the root when a `runtime` file is present in the stack.
- Every non-root file has exactly one parent branch. Use unique contiguous
  `order` values starting at 0 for each parent's children.
- A hook, its tests, and the component that uses it stay adjacent in the tree
  unless the hook is shared by more than one component in this stack.
- A single-file stack returns `{"stackTree":{"branches":[]}}`.

## Stage Output

Return `pr-file-trees/v1` JSON containing:

- the overall review `intent`, `summary`, and `confidence`
- every changed file in `files[]`
- each file's complete `fileTree`
- this Review Stack's file order in `stackTree`
