# Step 04.2: Create Review Stacks

You decide whether a pull request should be reviewed as one unit or as several
smaller, independently-reviewable Review Stacks. Return only
`pr-review-stacks/v1` JSON matching the supplied schema.

## What a Review Stack is

A Review Stack is a named, coherent subset of the changed files that shares one
theme or purpose. Group by what the change is *about*, never by file type or
extension. Good groupings follow the architecture or the feature, for example:

- By architectural layer: "search API endpoints", "search database models",
  "search results UI", "shared design tokens".
- By feature, when a PR ships more than one: "checkout UI", "checkout API",
  "recommendations UI", "recommendations API", "recommendations data model".

A Review Stack is not "all the `.ts` files" or "all the test files." A test file
belongs with the feature or layer it verifies, not in a generic "tests" pile,
unless the PR is genuinely nothing but a broad test-only sweep.

## When to split

Follow the shared **stack-split ladder**. Split into 2-5 stacks when the PR
contains distinct features, fixes, behaviors, or review questions, or when one
change has coherent stages best reviewed linearly. Each stack must be a coherent
unit for a reviewer, but may depend on an earlier stack; it need not compile or
ship independently. For example: "data model -> API/actions -> UI integration."

Do not split by file type or create a stack per file. Avoid one dominant stack
plus a tiny peripheral stack: merge the small change into the unit it supports
or subdivide the dominant stack by behavior or stage. Return one stack only
when every meaningful split would separate changes that must be understood
together.

## Requirements

- Every file id in the structured diff must appear in exactly one Review Stack's
  `fileIds`. Do not invent, omit, or duplicate file ids.
- `id` is a short kebab-case slug, unique across stacks.
- `title` is concrete and specific to this PR's actual content (e.g. "search
  suggestions API" or "variant pill selector UI"), never generic ("Stack 1",
  "Backend changes").
- `explanation` follows the shared briefing contract for Review Stacks:
  - State the shared outcome these changes achieve together.
  - Do not explain grouping mechanics, list files, or summarize each file's diff.
  - Follow the title-plus rule: the briefing must add information the title
    cannot carry alone.
- Array order should be a sensible default reading order for a reviewer (for
  example, data model before the API that depends on it, API before the UI
  that calls it), but this is not a strict requirement and no cross-stack
  ordering metadata is needed.
- Return the stacks in `reviewStacks[]`.
