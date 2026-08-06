# Review Website

The `src/` directory owns the complete local cockpit and generated review
website.

## Layout

- `src/App.jsx` and `src/main.jsx`: root cockpit application and browser entry.
- `src/pages/`: review queue, analysis queue, and scoring pages.
- `src/components/`, `src/hooks/`, and `src/lib/`: shared UI, state, and helpers.
- `src/review/render.js`: builds the standalone review HTML and transforms analysis
  plus diff data for the browser.
- `src/review/review-tree-app.jsx`: React Flow review application.
- `src/review/section-tree-model.js`: deterministic presentation-only tree folding.
- `src/index.css`: cockpit Tailwind entry; `src/review/styles.css` styles generated reviews.
- `src/components/ui/`: shadcn components used by the application.
- `server.mjs`: serves the cockpit, APIs, and generated pages on one port.
- `tests/webview/`: renderer, hosting, and presentation-model regression checks.
- `docs/dev-agent-browser.md`: browser-development guidance.

The website consumes the validated analysis schema and diff inventory from
`workflows/pr-review-analysis/`; it does not author or repair AI analysis.
Review Stack headers, Review Section headers, Review Groups, and Review Branches
expose their explanations through shadcn Hover Cards. Markdown is rendered
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

Start the local cockpit and review server:

```sh
pnpm web
```

Open `http://127.0.0.1:4397/` for the inbox or `/analysis` for analysis status.
Generated review trees remain available at both their run-specific URL and the stable
`.reviews/<review-slug>/index.html` route.
