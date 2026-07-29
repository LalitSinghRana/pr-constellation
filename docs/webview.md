# Review Website

The `src/` directory owns the generated PR review website and all
browser-facing implementation.

## Layout

- `src/render.js`: builds the standalone review HTML and transforms analysis
  plus diff data for the browser.
- `src/graph-app.jsx`: React Flow review application.
- `src/dashboard-app.jsx`: local PR/run benchmark dashboard.
- `src/dashboard-render.js`: builds the standalone dashboard HTML.
- `src/mini-tree-model.js`: deterministic presentation-only tree folding.
- `src/styles.css`: Tailwind entry and website styling.
- `src/dashboard.css`: dashboard layout and timing-waterfall styling.
- `src/components/ui/`: shadcn components used by the application.
- `vite.config.js`: serves the dashboard and generated pages from `.reviews/`.
- `tests/webview/`: renderer, hosting, and presentation-model regression checks.
- `docs/dev-agent-browser.md`: browser-development guidance.

The website consumes the validated analysis schema and diff inventory from
`workflows/pr-graph-analysis/`; it does not author or repair AI analysis.
File groups, mini-tree node headers, collapsed groups, and review edges expose
their What/Why comments through shadcn Hover Cards. Comment Markdown is rendered
with `react-markdown`, including structured bullet lists for longer
explanations.

Run its focused suite with:

```sh
pnpm check:webview
```

Run the root shadcn wrapper so `components.json` remains the single UI registry:

```sh
pnpm ui:add <component>
```

Start the local dashboard and review server:

```sh
pnpm web
```

Open `http://127.0.0.1:4173/reviews/`. The dashboard can queue new analyses,
while generated graphs remain available at both their run-specific URL and the
stable `.reviews/<review-slug>/index.html` route.
