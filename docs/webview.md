# Review Website

The `src/` directory owns the generated PR review website and all
browser-facing implementation.

## Layout

- `src/render.js`: builds the standalone review HTML and transforms analysis
  plus diff data for the browser.
- `src/graph-app.jsx`: React Flow review application.
- `src/mini-tree-model.js`: deterministic presentation-only tree folding.
- `src/styles.css`: Tailwind entry and website styling.
- `src/components/ui/`: shadcn components used by the application.
- `vite.config.js`: serves generated pages directly from `.reviews/`.
- `tests/webview/`: renderer, hosting, and presentation-model regression checks.
- `docs/dev-agent-browser.md`: browser-development guidance.

The website consumes the validated analysis schema and diff inventory from
`workflows/pr-graph-analysis/`; it does not author or repair AI analysis.

Run its focused suite with:

```sh
pnpm check:webview
```

Run the root shadcn wrapper so `components.json` remains the single UI registry:

```sh
pnpm ui:add <component>
```

Generate or re-render a review before starting Vite. Rendering writes the
timestamped page and a stable `.reviews/<review-slug>/index.html`:

```sh
pnpm web
```
