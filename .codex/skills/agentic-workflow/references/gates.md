# Gates

## Deterministic Gates

The project verifier runs:

```sh
pnpm check
```

This covers:

- Node syntax checks for CLI/source files.
- The generated React Flow webview bundle check.

For generated PR review pages, also run the relevant product commands:

```sh
pnpm prc -- analyze <github-pr-url>
pnpm prc -- view <run-dir>
```

Use a small known PR for smoke tests when the task is generic:

```sh
https://github.com/PicnicSupermarket/picnic-store-app/pull/3504
```

## Semantic Review

Review the diff for:

- CLI contract regressions.
- Broken headless `analyze` behavior.
- Broken `view` behavior.
- Schema drift between `analysis.json`, renderer, and graph UI.
- Browser-only breakage hidden by Node checks.
- Generated artifact churn committed accidentally.

Blockers:

- `pnpm check` fails.
- `prc analyze` cannot produce valid `analysis.json`.
- `prc view` cannot render `index.html`.
- UI task changes without browser inspection.
- Page errors in Agent Browser for the changed flow.

Major findings:

- Graph is visually unusable.
- Node/edge comments are not surfaced when expected.
- Diff and graph cannot both be reached.
- Tooling docs are stale or misleading.

Minor findings:

- Small copy, spacing, naming, or polish issues that do not block use.
