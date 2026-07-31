# PR Review Cockpit

A local webpage that turns GitHub pull requests into an additive, prioritized
review queue.

## Queue structure

PRs are selected by lifecycle and repository, then grouped by their last update
date. Non-PR GitHub notifications have their own view.

The local queue is populated from open and merged pull requests in:

- `PicnicSupermarket/picnic-store-config`
- `PicnicSupermarket/picnic-store-app`
- `PicnicSupermarket/picnic-page-platform-modules`

Once tracked, a PR remains in the local queue. GitHub notification history
refreshes tracked PRs and can add a missing PR when its reason is
`review_requested`. Reading or marking a GitHub notification has no effect on
the local Done state.

- **Reviewed**: your latest review commented or requested changes (`+10`)
- **New / unreviewed**: relevant PRs you have not reviewed (`0`)
- **Approved**: your latest review approved the PR (`-5`)
- **Merged**: merged PR notifications stay quiet until new activity (`-5`)
- **Draft**: draft PRs (`-10`)
- **My pull requests**: your open PRs (`0`)
- **Non-PR**: issues, CI, security, and other GitHub notification types

Fresh signals add to the lifecycle score:

| Signal | Weight |
| --- | ---: |
| Direct review request | +10 |
| Comment after the PR was merged | +10 |
| Configured teammate authored the PR | +7 |
| Reply to your review comment | +6 |
| New commits after your latest review | +3 |
| Configured GitHub team requested | +3 |
| General new comments after your latest review | +2 |
| Team request already covered by a configured teammate | -4 |

Each signal type counts once. Incoming activity never resets the lifecycle
base; only your next review changes the lifecycle.

The complete scoring table and worked examples are available locally at
<http://127.0.0.1:4173/scoring>.

## Run locally

Prerequisites: Node.js 20+, the
[GitHub CLI](https://cli.github.com/), and an authenticated account:

```sh
gh auth login
npm install
npm start
```

Open <http://127.0.0.1:4173/reviews>. Use **Configure team** to add teammate usernames
and GitHub teams in `org/team` format.

Install the macOS background sync once:

```sh
pnpm install:sync
```

It runs immediately and then hourly through `launchd`. Run `pnpm sync` for a
manual reconciliation. Re-run `pnpm install:sync` after updating the sync code.

The server listens only on localhost and reuses the active `gh` login. It stores
no GitHub token. Team settings are stored at
`~/.config/pr-review-cockpit/settings.json`; tracked items, local read markers,
and Done state are stored at `~/.config/pr-review-cockpit/queue.json`. Opening a
PR dims its current version; a later update restores it, with the detected
changes shown on hover. GitHub's own read flag has no effect. Analyzer stage,
queue, timing, and failures are available at `/analyze`. The page loads the
local queue immediately and polls notification changes every five minutes. The
hourly worker and **Refresh
GitHub** action perform one historical backfill, then check every open PR and
recently updated merged PRs. Open PRs with no activity for a week and merged PRs
with no activity for a day are automatically marked Done. A completed item
resurfaces when the pull request changes, including when a comment arrives after
merge.

The UI uses React, Vite, Tailwind CSS, and a small set of local shadcn/ui
components with the custom **Ink & Ember** theme. The Node server runs Vite as
middleware, so the UI and GitHub API still share one command and one port.

## Verify

```sh
npm run build
npm test
```

No webhooks, database, or OAuth app are required.
