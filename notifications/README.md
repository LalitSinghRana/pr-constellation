# PR Review Cockpit

A local webpage that turns GitHub pull requests into an additive, prioritized
review queue.

## Queue structure

**Everything** contains the full local queue, including non-PR GitHub
notifications. PRs are grouped by lifecycle first, then shown in separate
repository cards. Repository tabs provide a second-level filter:

GitHub searches enrich unread notifications and your own open PRs with scoring
signals; they do not bring dismissed notifications back into the queue.

- **Reviewed**: your latest review commented or requested changes (`+10`)
- **New / unreviewed**: relevant PRs you have not reviewed (`0`)
- **Approved**: your latest review approved the PR (`-5`)
- **Merged**: merged PR notifications stay quiet until new activity (`-5`)
- **Draft**: draft PRs (`-10`)
- **My pull requests**: your open PRs (`0`), with unread activity added on top
- **Other notification PR**: an unread PR notification without another matching lifecycle
- **Non-PR**: issues, CI, security, and other GitHub notification types

Fresh signals add to the lifecycle score:

| Signal | Weight |
| --- | ---: |
| Direct review request | +10 |
| Comment after the PR was merged | +10 |
| Configured teammate authored the PR | +7 |
| Reply to your review comment | +6 |
| Direct mention | +6 |
| Unread activity on your PR | +5 |
| New commits after your latest review | +3 |
| Configured GitHub team requested | +3 |
| General new comments after your latest review | +2 |
| Configured GitHub team mentioned | +2 |
| Team request already covered by a configured teammate | -4 |

Each signal type counts once. Incoming activity never resets the lifecycle
base; only your next review changes the lifecycle.

The complete scoring table and worked examples are available locally at
<http://127.0.0.1:4174/scoring>.

## Run locally

Prerequisites: Node.js 20+, the
[GitHub CLI](https://cli.github.com/), and an authenticated account:

```sh
gh auth login
npm install
npm start
```

Open <http://127.0.0.1:4174>. Use **Configure team** to add teammate usernames
and GitHub teams in `org/team` format.

The server listens only on localhost and reuses the active `gh` login. It stores
no GitHub token. Team settings are stored at
`~/.config/pr-review-cockpit/settings.json`; Done state remains in this browser's
local storage. A completed item resurfaces when its signals or GitHub update time
change.

The UI uses React, Vite, Tailwind CSS, and a small set of local shadcn/ui
components with the custom **Ink & Ember** theme. The Node server runs Vite as
middleware, so the UI and GitHub API still share one command and one port.

## Verify

```sh
npm run build
npm test
```

No webhooks, database, or OAuth app are required.
