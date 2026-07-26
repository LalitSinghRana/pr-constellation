# Development Browser Agent

This project uses Vercel Agent Browser as local development tooling for UI
iteration. It is not part of the PR Review Cockpit product runtime.

Agent Browser lets an agent open a page in Chrome, inspect the accessibility
tree, read DOM text/HTML, click elements, take screenshots, inspect React, read
console errors, inspect network requests, and compare visual snapshots.

For end-to-end agentic development, invoke `@agentic-workflow`. That workflow
uses Agent Browser when a task affects generated HTML, React Flow, styling,
layout, or browser behavior.

## Project Scripts

Run a local Agent Browser health check:

```sh
pnpm ab:doctor
```

Run any Agent Browser command:

```sh
pnpm ab -- open --enable react-devtools file:///absolute/path/to/index.html
pnpm ab -- snapshot
pnpm ab -- screenshot .context/agent-browser/page.png
pnpm ab -- console
pnpm ab -- errors
pnpm ab -- react tree
pnpm ab -- close --all
```

Start the MCP server manually:

```sh
pnpm ab:mcp
```

## Codex MCP Setup

The Codex MCP server is registered globally as `agent-browser` with:

```sh
codex mcp add agent-browser -- npm exec --yes --registry=https://registry.npmjs.org/ agent-browser@latest -- mcp --tools core,react,debug,network
```

Verify it with:

```sh
codex mcp get agent-browser
```

Remove it with:

```sh
codex mcp remove agent-browser
```

## Chat Usage

In the current chat, the agent can always invoke Agent Browser through shell
commands such as:

```sh
pnpm ab -- open --enable react-devtools file:///absolute/path/to/index.html
pnpm ab -- snapshot
pnpm ab -- screenshot .context/agent-browser/current.png
pnpm ab -- errors
```

For native MCP tool calls, start a new Codex/Conductor chat after the MCP server
has been registered. MCP tools are loaded when the session starts. In that new
chat, ask for Agent Browser directly, for example:

```text
Use Agent Browser to open the latest generated review page, inspect the graph,
check console errors, and tell me what looks broken.
```

or:

```text
Use Agent Browser to open the local review webview, take a screenshot, inspect
the React tree, and iterate on any layout issues you find.
```
