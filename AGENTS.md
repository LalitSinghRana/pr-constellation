# PR Review Cockpit Agent Instructions

When the user invokes `@agentic-workflow`, use the project-local skill at
`.codex/skills/agentic-workflow/SKILL.md`.

Default project checks:

```sh
pnpm check
```

Before creating a UI component, check the existing `src/components/ui`
directory, the shadcn component registry, and maintained npm packages for a
suitable implementation. Reuse or install an established component when it
satisfies the interaction and accessibility requirements. Hand-written generic
UI primitives are a last resort; create one only when no suitable library
component exists or the component is inherently project-specific. Add shadcn
components with `pnpm exec shadcn add <component>` so the root `components.json`
remains the single UI registry.

For UI work, use Agent Browser through the project scripts:

```sh
pnpm ab -- open --enable react-devtools <url>
pnpm ab -- snapshot
pnpm ab -- errors
pnpm ab -- console
pnpm ab -- screenshot .context/agent-browser/current.png
pnpm ab -- close --all
```

For user-facing review URLs, always serve generated reviews from the fixed local
server port and give the user the localhost URL:

```sh
pnpm dev
```

The canonical user-facing route is stable across generated revisions:

```text
http://127.0.0.1:4397/reviews/<review-slug>/
```

Do not give `file://` or timestamped URLs as the main handoff URL. The stable
route serves the stable `index.html` generated for that review slug. Historical
revisions remain addressable by their `/reviews/<review-slug>/<run-id>/`
subpaths on the same server. If port `4397` is already in use,
reuse that server when it is serving this workspace, or stop it before starting
a new one; do not switch to a random port.

Generated review runs live under `.reviews/` and are gitignored. Do not commit
generated review artifacts unless explicitly requested.

Don't reinvent the wheel: if a popular, well-maintained npm package solves the
problem (e.g. URL-synced state, date parsing, form validation), use it instead
of hand-rolling the equivalent logic.
