# 06 Judge Candidate

Files:

- `prompt.md`
- `schema.json`

This semantic judge runs after deterministic validation. It decides whether the
candidate would help or mislead a human reviewer.

The judge focuses on file-local review quality: classification, comments, risk,
logical root selection, and whether mini-tree edges express review causality
rather than source-file order.
