# 02 Fetch PR

Implementation:

- `cli/review-run.js`
- `workflows/pr-graph-analysis/02-fetch-pr/github.js`

This step:

1. Parses the GitHub PR URL.
2. Creates a timestamped run directory.
3. Fetches PR metadata and the cumulative patch with local GitHub auth.
4. Writes:
   - `metadata.json`
   - `diff.patch`
