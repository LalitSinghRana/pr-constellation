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

The CLI uses local `gh` authentication, fetches PR metadata and the cumulative
diff, then writes a timestamped run under `.reviews/<repo-pr-number>/`.
