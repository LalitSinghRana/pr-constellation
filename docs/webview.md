# Review Website

The `client/src/` directory owns the complete local cockpit and generated review
website.

## Layout

- `client/src/App.jsx` and `client/src/main.jsx`: root cockpit application and browser entry.
- `client/src/pages/`: review queue, analysis queue, and scoring pages.
- `client/src/components/`, `client/src/hooks/`, and `client/src/lib/`: shared UI, state, and helpers.
- `client/src/review/render.js`: builds the standalone review HTML and transforms analysis
  plus diff data for the browser.
- `client/src/review/review-tree-app.jsx`: React Flow review application.
- `client/src/review/section-tree-model.js`: deterministic presentation-only tree folding.
- `client/src/index.css`: cockpit Tailwind entry; `client/src/review/styles.css` styles generated reviews.
- `client/src/components/ui/`: shadcn components used by the application.
- `server/server.mjs`: serves the cockpit, APIs, and generated pages on one port.
- `client/tests/`: renderer and presentation-model regression checks.
- `analysis-worker/tests/check-review-hosting.js`: generated-review publication regression check.
- `docs/dev-agent-browser.md`: browser-development guidance.

The website consumes the validated analysis schema and diff inventory from
`analysis-worker/workflow/`; it does not author or repair AI analysis.
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
