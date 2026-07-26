# PR Review Cockpit

An early-stage project for a human-first pull request review assistant.

The goal is to help reviewers move through large PRs quickly by showing the
feature intent, highest-signal files, causal change path, acceptance criteria,
and senior/product/QA review risks without drowning them in generated files,
tests, fixtures, or Storybook noise.

## Dirty v0

Install dependencies:

```sh
pnpm install --registry=https://registry.npmjs.org/
```

Generate a local review page for a GitHub PR:

```sh
pnpm prc -- https://github.com/OWNER/REPO/pull/123
```

Open it automatically:

```sh
pnpm prc -- https://github.com/OWNER/REPO/pull/123 --open
```

Generate a Codex-backed logical review graph:

```sh
pnpm prc -- analyze https://github.com/OWNER/REPO/pull/123
```

Render an existing run directory, including the graph when `analysis.json`
exists:

```sh
pnpm prc -- view .reviews/REPO-123/2026-01-01T00-00-00-000Z --open
```

Serve generated reviews on one local port:

```sh
pnpm web
```

The latest generated run for each PR is available at a stable URL:

```text
http://127.0.0.1:4173/reviews/REPO-123/
```

Timestamped revision URLs remain available for historical runs. You can also
select a specific run with a query param:

```text
http://127.0.0.1:4173/?review=REPO-123/2026-01-01T00-00-00-000Z
```

The CLI uses local `gh` authentication, fetches PR metadata and the cumulative
diff, then writes a timestamped run under `.reviews/<repo-pr-number>/`.

The `analyze` command is headless. It invokes `codex exec` in read-only mode and
writes one file-local mini-tree per changed file to `analysis.json`; it does not
render the webview. The Tree view places those independent file mini-trees on
the canvas and renders their nodes as code diffs. Primary edges follow the
AI-authored review hierarchy. Technical cross-links remain available in the
JSON views without adding unlabeled edges to the canvas. Supporting and
mechanical sibling forests start in deterministic expandable groups so the
first pass stays focused on core and important runtime work.
