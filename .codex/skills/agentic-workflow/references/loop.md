# Loop

Use at most 5 attempts. One attempt is one implementation or fix pass followed
by verification and self-review.

## Attempt 0

Before edits, record:

```sh
git status --short
git rev-parse HEAD
```

Run:

```sh
.codex/skills/agentic-workflow/scripts/verify.sh
```

If baseline fails for unrelated reasons, use baseline-delta accounting and say
so in the final report. If baseline failure blocks the task, stop and ask.

## Repeating Attempt

For each attempt:

1. State the intended change area.
2. Edit narrowly.
3. Run the full verifier.
4. Review your diff against `references/gates.md`.
5. If UI is involved, inspect a real generated page with Agent Browser.
6. Fix root causes, not symptoms.

Never weaken a gate, skip relevant validation, or hide failures.

## Exhaustion

After 5 failed attempts, stop. Report:

- failing gate output or browser issue
- what was fixed
- what remains
- the next decision needed from the user
