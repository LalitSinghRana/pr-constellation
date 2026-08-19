import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const JUDGE_SCHEMA_PATH = path.join(WORKFLOW_DIR, "06-judge-candidate", "schema.json");

export function buildJudgePrompt({
  candidateText,
  judgePrompt,
  metadataText,
  structuredDiffText,
  validationReport,
}) {
  return `${judgePrompt}

## Inline Input

Use the inline input below. The structured diff is the complete source input.
Do not call tools or read files unless it is insufficient for semantic
judgment.

### metadata.json

<metadata_json>
${metadataText}
</metadata_json>

### Structured diff

<structured_diff_json>
${structuredDiffText}
</structured_diff_json>

### Step 05 validation result

<validation_result>
${validationReport}
</validation_result>

### analysis.candidate.json

<analysis_candidate_json>
${candidateText}
</analysis_candidate_json>

Judge the candidate review tree analysis as your final answer.
`;
}

export async function runJudge({
  candidateText,
  cwd,
  executionConfig,
  execute,
  judgePrompt,
  metadataText,
  outputPath,
  structuredDiffText,
  validationReport,
}) {
  await execute({
    cwd,
    ...executionConfig,
    outputPath,
    prompt: buildJudgePrompt({
      candidateText,
      judgePrompt,
      metadataText,
      structuredDiffText,
      validationReport,
    }),
    schemaPath: JUDGE_SCHEMA_PATH,
  });

  return parseJsonObject(await readFile(outputPath, "utf8"));
}

function parseJsonObject(text) {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    throw new Error("Analysis executor did not return a JSON object.");
  }
}

export function validateJudge(judge) {
  const errors = [];

  if (judge?.schemaVersion !== "pr-review-judge/v1") {
    errors.push("judge.json has an invalid or missing schemaVersion.");
  }

  if (judge?.verdict !== "pass" && judge?.verdict !== "fail") {
    errors.push("judge.json must use verdict pass or fail.");
  }

  if (!isNonEmptyString(judge?.summary)) {
    errors.push("judge.json must include a summary.");
  }

  if (
    typeof judge?.confidence !== "number" ||
    !Number.isFinite(judge.confidence) ||
    judge.confidence < 0 ||
    judge.confidence > 1
  ) {
    errors.push("judge.json confidence must be a number from 0 to 1.");
  }

  if (!Array.isArray(judge?.findings)) {
    errors.push("judge.json must contain a findings array.");
  } else {
    for (const [index, finding] of judge.findings.entries()) {
      if (!isNonEmptyString(finding?.explanation)) {
        errors.push(`judge.json finding ${index + 1} must include a non-empty explanation.`);
      }
    }
  }

  if (errors.length > 0) {
    throwValidationError(errors);
  }
}

export function formatJudgeFailure(judge) {
  const findings = (judge.findings || [])
    .map((finding) => {
      const target = finding.targetId ? ` ${finding.targetId}` : "";
      return `- ${finding.severity}/${finding.type}${target}: ${finding.explanation}`;
    })
    .join("\n");

  return `Step 06 judge candidate failed: ${judge.summary}${findings ? `\n${findings}` : ""}`;
}

function throwValidationError(errors) {
  throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
