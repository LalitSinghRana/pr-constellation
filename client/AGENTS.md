# AGENTS.md — client/

## Commands

- `pnpm dev` — start PR Constellation with Vite hot reload at `http://127.0.0.1:4397/`
- `pnpm test` — run all tests; use `node --test --test-concurrency=1 client/tests/<file>` for focused checks
- `pnpm exec shadcn add <component>` — add shadcn primitives from repository root (`components.json` is the single UI registry)
- `pnpm exec biome format --write <paths>` — format touched files

## Tech stack

- **Runtime:** Node 24, React 19, Vite 8
- **Package manager:** pnpm (not npm, not yarn)
- **Linter/Formatter:** Biome (not ESLint, not Prettier)
- **Styling:** Tailwind utility classes + theme tokens from `client/src/theme.css`
- **UI primitives:** Radix/shadcn in `client/src/components/ui/`
- **Review canvas:** React Flow (`@xyflow/react`), Shiki, `@git-diff-view/react`
- **URL state:** `nuqs` for shareable filter/selection state

## Architecture

`client/` owns the PR Constellation UI, generated React Flow review pages, renderer, Shiki
integration, shared shadcn primitives, and browser-facing tests.

```text
client/src/
├── App.jsx, main.jsx          app entry
├── pages/                     route screens (inbox, analysis, settings, review-page)
├── components/                shared business UI
├── components/ui/             domain-agnostic shadcn primitives
├── hooks/                     hooks shared across pages
├── lib/                       pure browser/domain helpers
└── review/                    generated review bundle + render.js
    ├── render.js              builds standalone review HTML (Node executes this)
    ├── review-tree-app.jsx    React Flow review application
    └── section-tree-model.js  deterministic presentation-only tree folding
```

The review website consumes validated analysis schema and diff inventory from
`analysis-worker/workflow/`; it does not author or repair AI analysis.

Review Stack headers, Review Section headers, Review Groups, and Review Branches
expose explanations through shadcn Hover Cards. Markdown uses `react-markdown`.

Generated review URLs:

```text
http://127.0.0.1:4397/reviews/<review-slug>/
http://127.0.0.1:4397/reviews/<review-slug>/<run-id>/
```

## Conventions

- Pages in `client/src/pages/` compose route screens; colocate page-specific
  files under `client/src/pages/<feature>/`.
- Put shared business UI in `client/src/components/`; promote to
  `client/src/components/ui/` only for domain-agnostic shadcn primitives.
- Keep the review bundle under `client/src/review/` with a thin
  `pages/review-page.jsx` entry point.
- Put a hook in `client/src/hooks/` only when multiple components share the
  stateful behavior.
- Style with Tailwind in JSX; use `client/src/theme.css` tokens. Keep
  `react-flow.css` and Shiki hooks in CSS modules where Tailwind cannot express
  library DOM hooks cleanly.
- Tests live in `client/tests/`. Renderer regression: `client/tests/diffview-render.test.js`.
  Hosting regression: `analysis-worker/tests/review-hosting.test.js`.
