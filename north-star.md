Next improvements

### Rendering architecture (TODO)
- No conventional React SSR in this app.
- `/`, `/analysis`, `/scoring` — Vite SPA routes; all cockpit UI mounts into `#root` client-side.
- `/reviews/<slug>/` — server-generated at analysis time: Node builds and saves static `index.html` with inline CSS/JS, PR metadata, analysis-tree data, and precomputed Shiki syntax tokens. But the HTML shell has an empty `#pr-review-root`; the visible review UI (tree, React Flow graph, diffs, timeline, comments, draft UI) is rendered in the browser by the bundled React app.
- So: review pages are **server-generated, not server-side-rendered React HTML**. The document is static; none of the interactive UI DOM is server-rendered.

### UI/UX
- ~a clean snap flow from file to file or node-to-node. with arrow navigation~
- ~graph and rest of website should be merge for style~
- ~Do full review and leave comments from my local website~
- ~move rendering and shiki styling from backend to frontend.~
- ~show GH PR 'conversation' tab~
- timer to review the PRs. Each review-stack should have their own timer based on #LOC. No need for AI, we can deterministically do this.
- ~Priority queue: bands bumped → none → past-fail/cancel → past-success; within band by score; Prioritize button~
- ~useQuery and refactor all existing api calls~
- ~RSC for things that should come local server/db. but do we need it if it's running locally and is super fast.~
- ~Settings page. Auto queue, mini-map toggle.~
- decouple pages from server. Ideally Only react-flow should come from server.
- Long git-diff files break out of node boundaries. http://127.0.0.1:4397/reviews/gh-17-picnicsupermarket-19-picnic-store-config-4993/ or http://127.0.0.1:4397/reviews/gh-17-picnicsupermarket-19-picnic-store-config-4993/ or http://127.0.0.1:4397/reviews/gh-17-picnicsupermarket-16-picnic-store-app-3558/
- Move 0.1x / 1x / 10x toggle from header to inside the scope of review-trees
- sorting by simple-smallest, simple-large, complex-large to get smaller ones get finished quickly
- set-up notifications
- Review comments improvements:
  - The box can be more wider and scrollable for content inside it.
  - Existing review comment threads should be open by default.
  - Is it possible to have this anchor to the node, float to left of node, but doesn't take space in node or group wrapper. It should scroll with the node anchor point.
  - use: https://github.com/PicnicSupermarket/picnic-store-config/pull/4919#discussion_r3702665359 as test target
  - When typing comments edges flickers. There might be re-rendering happening
  - In "review" button, we show other existing comments also. It should only show draft comments only.

###~AI layer~
- ~build layer flow (middle tree)~
- ~should we skip generated files from analyse pipeline? Like snapshots.~
- ~Hide noise~

### ~DX~
- ~Better, consistent and meaningful terms for everything~
- ~Reorganize into mini-projects. server, client, ai-workflow~
- ~Wrise agent.md for coding guidelines~
- ~setup biome~
- ~cleanup code using agent.md~
- ~do proper server project. Should be light weight to run continously with low CPU usage. We can go other language other than JS here.~
- remove any codex or claude specific mention, instructions, code, etc

---

- Explore memory-graph by BE team
- llm-wiki for repo?
- https://deepwiki.com/
