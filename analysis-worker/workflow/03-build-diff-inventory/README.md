# 03 Build Diff Inventory

Implementation:

- `diff-inventory.js`

This deterministic step parses `diff.patch` and writes:

- `diff-inventory.json`: full coverage data with changed and context lines.
- `diff-summary.json`: compact AI input with changed files, hunks, changed line
  ids, and changed line text only.

The inventory assigns stable ids to every added/deleted changed line. Later AI
steps must cover these ids exactly once. The summary keeps generation prompts
smaller without becoming the source of truth.
