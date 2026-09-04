# Roadmap

What PR Constellation does today, and where it goes next. Order is intent, not a schedule.

## Now

- Understand how changes connect: review a pull request as Review Stacks and linked
  file/section nodes instead of an isolated file list.
- Reduce noise or choose the depth you need with 0.1x, 1x, and 10x density.
- Review in context: each node explains why the change matters; inspect the diff and PR
  conversation, then draft review comments without leaving the review.
- See what needs attention at a glance: the GitHub inbox is ranked so priority pull
  requests surface first.

## Next

- Chat with the review analysis to ask questions about the PR before leaving a comment.
- Connect a review to a local checkout. Expanding a file shows its complete base-to-head
  git diff and surrounding source from disk, not only the generated review section.
- Mark a file or section read, GitHub-style.
- Time-box each review stack from LOC (deterministic, no model).
- Sort the inbox by simple/small vs complex/large so quick reviews surface first.
- Add a GitHub-like review side panel for conversation, drafts, and the current node.
- Remember density preferences per repository.

## Later

- Ground reviews in a generated repository wiki (llm-wiki / DeepWiki-style).
- Add a project memory graph so reviews carry architectural language, relationships,
  and invariants across pull requests.
- Send browser or Slack notifications when inbox items change.
- Add a VS Code / Cursor extension.
- Explore a GitHub App or hosted option while retaining the local workflow.
