# 01 CLI Start

Entry point:

- `analysis-worker/bin/prc.js`
- `analysis-worker/cli.js`

Current command:

```sh
prc analyze <github-pr-url>
```

The CLI creates an analysis run under `.reviews/<repo-pr-number>/<timestamp>/`
and delegates to `createAnalysisRun`.
