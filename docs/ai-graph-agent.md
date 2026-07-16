# AI Graph Agent

The AI agent has one job: read a PR, understand the change, and generate a
headless graph JSON file.

It does not know or care how the graph will be drawn in the UI. It should not
produce layout hints, visual instructions, or reviewer-interface copy. The web
app can decide how to render the graph later.

## Inputs

The agent reads:

- `metadata.json`: PR title, body, author, branches, files, commits, and counts.
- `diff.patch`: cumulative PR diff.

## Output

The agent writes:

- `analysis.json`: a logical change graph.

The graph contains:

- PR intent and a short summary.
- Nodes for meaningful changes or concepts in the PR.
- Edges for causal relationships between those nodes.
- Evidence tying each node back to the diff.

Each node must include a high-level `comment` explaining why that change exists
or why it matters.

Each edge must include a `comment` explaining why the source change caused,
enabled, or required the target change.

## Subtasks

1. Fetch PR data with local `gh` auth.
2. Store `metadata.json` and `diff.patch` in a timestamped run directory.
3. Invoke `codex exec` in read-only mode.
4. Require the final response to match
   `schemas/pr-graph-analysis.schema.json`.
5. Validate basic graph integrity, including node ids and edge endpoints.

## Backend

Use Codex for now because it already supports non-interactive execution and
schema-constrained final output through `codex exec --output-schema`.

The graph JSON contract should stay stable even if the backend later changes
from Codex to another agent or LLM pipeline.
