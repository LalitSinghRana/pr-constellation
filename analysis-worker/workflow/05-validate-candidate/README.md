# 05 Validate Candidate

`validate-analysis.js` validates both generation boundaries:

- `validateReviewStacks` checks `pr-review-stacks/v1` grouping and exact file
  coverage.
- `validateReviewAnalysis` checks the assembled `pr-review-analysis/v1`
  document.

The final validator enforces exact file and changed-line ownership, approved
classifications, non-empty explanations, one rooted Section Tree per file, one
rooted File Tree per Review Stack, contiguous sibling order, and a sensible
File Tree root.
