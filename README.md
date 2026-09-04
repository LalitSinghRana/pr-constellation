# PR Constellation

See how every change connects in a PR without the noise.

Roadmap: [ROADMAP.md](ROADMAP.md).

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm 10 — `corepack enable`
- GitHub CLI — `gh auth login`
- Cursor Agent CLI (`agent`) signed in — default analysis provider  
  Claude or Codex CLIs also work if you switch provider in Settings

## Install

```sh
nvm use
corepack enable
pnpm install --registry=https://registry.npmjs.org/
gh auth login
pnpm dev
```

Open [http://127.0.0.1:4397/](http://127.0.0.1:4397/).

## First run

1. Open **Settings → Team** and add teammate GitHub usernames and/or `org/team`
   slugs (comma-separated). The inbox stays empty until you save a team.
2. Confirm the analysis agent probe succeeds.
3. To post draft review comments: `gh auth refresh -s repo`

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server with hot reload on port `4397` |
| `pnpm check` | Format, lint, tests, client build |

Optional headless analysis (run from the **repo root**):

```sh
node analysis-worker/bin/prc.js https://github.com/OWNER/REPO/pull/123
node analysis-worker/bin/prc.js analyze https://github.com/OWNER/REPO/pull/123
```

## Where data lives

All mutable data for a clone is gitignored under the project root:

| Path | What |
|---|---|
| `<repo>/database/cockpit.sqlite3` | Inbox, settings, sync, drafts |
| `<repo>/.reviews/.run-store.sqlite` | Analysis queue |
| `<repo>/.reviews/<slug>/` | Review run artifacts |

Each checkout has its own data. Running two clones at once requires a different
`PORT` on one of them.

## Troubleshooting

| Problem | Fix |
|---|---|
| Port `4397` in use | Stop the other process, or set `PORT` for a second checkout |
| Agent probe fails | Install/sign in `agent`, or switch provider in Settings |
| `better-sqlite3` build fails | Need a working Node native toolchain; `postinstall` rebuilds it |
| Corporate npm registry | Keep `--registry=https://registry.npmjs.org/` (see `.npmrc`) |

Optional env: `PORT`, `PRC_DISABLE_SYNC=1`, and `PRC_*_TIMEOUT_MS` overrides.
