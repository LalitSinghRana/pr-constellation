# 07 Run Retry Loop

`codex-agent.js` runs each attempt in labeled order:

1. Generate all file mini-trees and persist the exact AI output.
2. Write `analysis.raw.json`.
3. Run deterministic mini-tree validation.
4. Write `analysis.candidate.json`.
5. Run the semantic judge with the validation result.
6. Only after judging finishes, retry generation with combined validation and
   judge feedback when either step fails.
7. Write final `analysis.json` and `judge.json`.

The runner never repairs or rewrites AI-authored nodes or edges. It does not
invoke middle-tree or super-tree generation. If all attempts fail, the run
fails without a fallback analysis.
