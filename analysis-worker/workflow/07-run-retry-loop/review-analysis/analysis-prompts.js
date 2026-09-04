// The full structured diff (buildStructuredDiff) carries a per-line id/old/new
// line-number object for every line, which the review-stack schema never
// references (its output is just file ids grouped into stacks). For a large
// fixture that per-line bookkeeping alone overflowed a single prompt. This lean
// variant keeps every file's full code content but drops the ids/line-numbers
// the review-stack decision doesn't need, cutting a real fixture's prompt from
// ~1.42M to ~0.5M chars.
function buildReviewStackStructuredDiff(inventory) {
  return {
    schemaVersion: "pr-review-stack-diff/v1",
    files: (inventory?.files || [])
      .filter((file) => file.changedLineIds?.length > 0)
      .map((file) => ({
        id: file.id,
        path: file.path,
        status: file.status,
        add: file.addedLines ?? 0,
        del: file.deletedLines ?? 0,
        hunks: (file.hunks || [])
          .filter((hunk) => hunk.changedLineIds?.length > 0)
          .map((hunk) => ({
            header: hunk.header,
            lines: (hunk.lines || []).map(
              (line) =>
                `${line.kind === "insert" ? "+" : line.kind === "delete" ? "-" : " "}${line.content}`,
            ),
          })),
      })),
  };
}

export function buildReviewStacksPrompt({
  inventory,
  metadataText,
  previousFailure,
  reviewStacksPrompt,
}) {
  const reviewStackDiffText = `${JSON.stringify(buildReviewStackStructuredDiff(inventory))}\n`;

  return `${reviewStacksPrompt.trim()}
${buildReviewStacksRetryGuidance(previousFailure)}

## Inline Input

Use the inline input below. The structured diff below has one entry per
changed file (with its file id, path, and hunks); each hunk's lines are
unified-diff style ("+"/"-"/" " prefix plus content). Do not call tools or
read files unless this input is insufficient for semantic grouping.

### metadata.json

<metadata_json>
${metadataText}
</metadata_json>

### Structured diff

<structured_diff_json>
${reviewStackDiffText}
</structured_diff_json>

Decide the review stack split as your final answer.
`;
}

export function buildReviewTreesPrompt({
  metadataText,
  reviewTreesPrompt,
  previousFailure,
  sharedPrompt,
  structuredDiffText,
}) {
  return `${sharedPrompt.trim()}

${reviewTreesPrompt.trim()}
${buildRetryGuidance(previousFailure)}
${buildSourceInput({
  metadataText,
  structuredDiffText,
})}

Generate the complete File Tree and every changed file's Section Tree as your final answer.
`;
}

function buildReviewStacksRetryGuidance(previousFailure) {
  return previousFailure
    ? `
## Review Stacks Retry Feedback

The previous review-stacks answer failed deterministic validation:

${previousFailure}

Regenerate the complete review-stacks JSON from scratch and fix every reported issue while following the shared briefing contract above.
`
    : "";
}

function buildRetryGuidance(previousFailure) {
  return previousFailure
    ? `
## Step 07 Retry Feedback

The previous candidate reached step 07 after one combined evaluation. Step 05
deterministic validation ran first, then step 06 semantic judging inspected
every schema-usable candidate even when deterministic validation failed. It was
rejected for these combined reasons:

${previousFailure}

Regenerate the complete review tree analysis from scratch and fix every reported
issue while following the authoritative shared contract above.
`
    : "";
}

function buildSourceInput({ metadataText, structuredDiffText }) {
  return `
## Inline Input

Use the inline input below. The structured diff is the complete source input:
it contains file and hunk metadata, context lines, and every changed-line id
with its content. Do not call tools or read files unless this input is
insufficient for semantic grouping.

### metadata.json

<metadata_json>
${metadataText}
</metadata_json>

### Structured diff

<structured_diff_json>
${structuredDiffText}
</structured_diff_json>
`;
}
