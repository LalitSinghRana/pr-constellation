# 01 CLI Start

Entry point:

- `bin/prc.js`
- `cli/cli.js`

Current command:

```sh
prc analyze <github-pr-url>
```

The CLI creates an analysis run under `.reviews/<repo-pr-number>/<timestamp>/`
and delegates to `createAnalysisRun`.
