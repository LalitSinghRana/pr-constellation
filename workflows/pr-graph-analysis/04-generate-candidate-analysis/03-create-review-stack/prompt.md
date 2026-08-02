# Review Stack: Split This PR Into Coherent Review Units

You decide whether a pull request should be reviewed as one unit or as several
smaller, independently-reviewable "stacks." Return JSON matching the supplied
schema and nothing else.

## What a stack is

A stack is a named, coherent subset of the changed files that shares one
theme or purpose. Group by what the change is *about*, never by file type or
extension. Good groupings follow the architecture or the feature, for example:

- By architectural layer: "search API endpoints", "search database models",
  "search results UI", "shared design tokens".
- By feature, when a PR ships more than one: "checkout UI", "checkout API",
  "recommendations UI", "recommendations API", "recommendations data model".

A stack is not "all the `.ts` files" or "all the test files." A test file
belongs with the feature or layer it verifies, not in a generic "tests" pile,
unless the PR is genuinely nothing but a broad test-only sweep.

## When to split, and how many stacks

Look at the whole structured diff before deciding. Most small or single-purpose
PRs are already coherent: return exactly one stack rather than inventing a
split that adds no reviewing value. Split only when the PR visibly contains
more than one independent concern or feature, and a reviewer would benefit
from reviewing them separately. Prefer 2-5 stacks when splitting; do not
create a stack per file, and do not split solely because a PR touches many
files if those files all serve one coherent change.

## Requirements

- Every file id in the structured diff must appear in exactly one stack's
  `fileIds`. Do not invent, omit, or duplicate file ids.
- `id` is a short kebab-case slug, unique across stacks.
- `title` is concrete and specific to this PR's actual content (e.g. "search
  suggestions API" or "variant pill selector UI"), never generic ("Stack 1",
  "Backend changes").
- `comment` explains in one or two sentences why these particular files form
  one coherent review unit.
- Array order should be a sensible default reading order for a reviewer (for
  example, data model before the API that depends on it, API before the UI
  that calls it), but this is not a strict requirement and no cross-stack
  ordering metadata is needed.
