# Browser Review

Use Agent Browser for UI-facing changes.

## Open

For generated PR review pages, prefer the fixed local review server:

```sh
pnpm web <run-dir>
pnpm ab -- open --enable react-devtools http://127.0.0.1:4173/reviews/<review-slug>/<run-id>/
```

The review URL must stay on port `4173`. Each review revision should use its own
subpath:

```text
http://127.0.0.1:4173/reviews/<review-slug>/<run-id>/
```

Only use a direct `file://` URL when specifically debugging static-file loading
or when the user asks for the file path.

## Inspect

Run:

```sh
pnpm ab -- snapshot
pnpm ab -- errors
pnpm ab -- console
pnpm ab -- screenshot .context/agent-browser/current.png
```

For React-specific issues:

```sh
pnpm ab -- react tree
```

## What To Check

- The intended page or generated review artifact loaded.
- The key visible UI exists in the snapshot.
- Console/page errors are empty or understood.
- Screenshot shows no obvious overlap, clipping, blank graph, or broken layout.
- Interactive controls are reachable by stable snapshot refs where relevant.

Always close sessions after inspection:

```sh
pnpm ab -- close --all
```
