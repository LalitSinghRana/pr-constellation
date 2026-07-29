# 06 Judge Candidate

Files:

- `prompt.md`
- `schema.json`

This semantic judge is retained for offline benchmarking but is disabled in
the active retry loop. When invoked, it decides whether the
candidate would help or mislead a human reviewer.

The judge focuses on file-local review quality: classification, comments, risk,
logical root selection, and whether mini-tree edges express review causality
rather than source-file order.
