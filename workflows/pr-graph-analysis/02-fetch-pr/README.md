# 02 Fetch PR

Implementation:

- `src/review-run.js`
- `src/github.js`

This step:

1. Parses the GitHub PR URL.
2. Creates a timestamped run directory.
3. Fetches PR metadata and the cumulative patch with local GitHub auth.
4. Writes:
   - `metadata.json`
   - `diff.patch`
