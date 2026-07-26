import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateGraphAnalysis,
  validateMiniTreeAnalysis,
} from "../05-validate-candidate/validate-analysis.js";

const WORKFLOW_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CANDIDATE_WORKFLOW_DIR = path.join(WORKFLOW_DIR, "04-generate-candidate-analysis");
const SHARED_PROMPT_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "01-shared-contract",
  "prompt.md",
);
const MINI_TREES_PROMPT_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "02-create-mini-trees",
  "prompt.md",
);
const MINI_TREES_SCHEMA_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "02-create-mini-trees",
  "schema.json",
);
const JUDGE_PROMPT_PATH = path.join(WORKFLOW_DIR, "06-judge-candidate", "prompt.md");
const JUDGE_SCHEMA_PATH = path.join(WORKFLOW_DIR, "06-judge-candidate", "schema.json");
const MAX_ANALYSIS_ATTEMPTS = 3;
const CODEX_EXEC_TIMEOUT_MS = Number(process.env.PRC_CODEX_TIMEOUT_MS || 1800000);

export { validateGraphAnalysis, validateMiniTreeAnalysis };

export async function runCodexGraphAnalysis({ executeCodex = runCodexExec, runDir }) {
  const resolvedRunDir = path.resolve(runDir);

  await mkdir(resolvedRunDir, { recursive: true });

  const [sharedPrompt, miniTreesPrompt, judgePrompt] = await Promise.all([
    readFile(SHARED_PROMPT_PATH, "utf8"),
    readFile(MINI_TREES_PROMPT_PATH, "utf8"),
    readFile(JUDGE_PROMPT_PATH, "utf8"),
  ]);
  const inventory = await readJson(path.join(resolvedRunDir, "diff-inventory.json"));
  const metadataText = await readFile(path.join(resolvedRunDir, "metadata.json"), "utf8");
  const diffPatchText = await readFile(path.join(resolvedRunDir, "diff.patch"), "utf8");
  const diffLineMapText = `${JSON.stringify(buildDiffLineMap(inventory))}\n`;
  const fileMapText = `${JSON.stringify(buildFileMap(inventory))}\n`;
  const analysisPath = path.join(resolvedRunDir, "analysis.json");
  const candidatePath = path.join(resolvedRunDir, "analysis.candidate.json");
  const judgePath = path.join(resolvedRunDir, "judge.json");
  const failures = [];
  let analysis;
  let judge;
  let finalJudgeRawOutputPath;
  let finalPromptPath;
  let rawOutputPath;

  for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt += 1) {
    const artifacts = buildAttemptArtifacts({ attempt, runDir: resolvedRunDir });
    const attemptFailures = [];
    let attemptJudge;
    let candidate;
    let validationFailure = null;

    try {
      candidate = await runJsonStage({
        cwd: resolvedRunDir,
        executeCodex,
        outputPath: artifacts.miniTreesRawPath,
        prompt: buildMiniTreesPrompt({
          diffLineMapText,
          diffPatchText,
          fileMapText,
          metadataText,
          miniTreesPrompt,
          previousFailure: failures.at(-1),
          sharedPrompt,
        }),
        promptPath: artifacts.miniTreesPromptPath,
        schemaPath: MINI_TREES_SCHEMA_PATH,
      });
      await writeFile(
        artifacts.analysisRawPath,
        `${JSON.stringify(candidate, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      attemptFailures.push(formatStageFailure("04.2 create mini-trees", error));
    }

    if (candidate) {
      try {
        validateMiniTreeAnalysis(candidate, { inventory });
      } catch (error) {
        validationFailure = formatStageFailure("05 validate candidate", error);
        attemptFailures.push(validationFailure);
      }

      const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
      await writeFile(candidatePath, candidateText, "utf8");

      try {
        attemptJudge = await runJudge({
          candidateText,
          cwd: resolvedRunDir,
          diffLineMapText,
          diffPatchText,
          executeCodex,
          fileMapText,
          judgePrompt,
          metadataText,
          outputPath: artifacts.judgeRawPath,
          validationReport: buildValidationReport(validationFailure),
        });
        validateJudge(attemptJudge);

        if (attemptJudge.verdict !== "pass") {
          attemptFailures.push(formatJudgeFailure(attemptJudge));
        }
      } catch (error) {
        attemptFailures.push(formatStageFailure("06 judge candidate", error));
      }

      if (attemptFailures.length === 0) {
        analysis = candidate;
        judge = attemptJudge;
        finalJudgeRawOutputPath = artifacts.judgeRawPath;
        finalPromptPath = artifacts.miniTreesPromptPath;
        rawOutputPath = artifacts.analysisRawPath;
        break;
      }
    }

    failures.push(formatAttemptFailure({ attempt, failures: attemptFailures }));

    if (attempt === MAX_ANALYSIS_ATTEMPTS) {
      throw new Error(
        `PR mini-tree analysis failed after ${MAX_ANALYSIS_ATTEMPTS} complete attempts:\n\n${failures.join("\n\n")}`,
      );
    }
  }

  await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  await writeFile(judgePath, `${JSON.stringify(judge, null, 2)}\n`, "utf8");

  return {
    analysis,
    analysisPath,
    judge,
    judgePath,
    judgeRawOutputPath: finalJudgeRawOutputPath,
    promptPath: finalPromptPath,
    rawOutputPath,
  };
}

function buildAttemptArtifacts({ attempt, runDir }) {
  return {
    analysisRawPath: attemptArtifactPath(runDir, "analysis.raw", attempt, "json"),
    judgeRawPath: attemptArtifactPath(runDir, "judge.raw", attempt, "json"),
    miniTreesPromptPath: attemptArtifactPath(runDir, "mini-trees-prompt", attempt, "md"),
    miniTreesRawPath: attemptArtifactPath(runDir, "mini-trees.raw", attempt, "json"),
  };
}

function attemptArtifactPath(runDir, baseName, attempt, extension) {
  const attemptSuffix = attempt === 1 ? "" : `.attempt-${attempt}`;
  return path.join(runDir, `${baseName}${attemptSuffix}.${extension}`);
}

async function runJsonStage({
  cwd,
  executeCodex,
  outputPath,
  prompt,
  promptPath,
  schemaPath,
}) {
  await writeFile(promptPath, prompt, "utf8");
  await executeCodex({
    cwd,
    outputPath,
    prompt,
    schemaPath,
  });

  return parseJsonObject(await readFile(outputPath, "utf8"));
}

function buildFileMap(inventory) {
  return {
    schemaVersion: "diff-file-map/v1",
    changedLineCount: inventory?.changedLineCount || 0,
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
            id: hunk.id,
            header: hunk.header,
            lineIds: hunk.changedLineIds || [],
          })),
      })),
  };
}

function buildDiffLineMap(inventory) {
  const filesByPath = new Map(
    (inventory?.files || [])
      .filter((file) => file.changedLineIds?.length > 0)
      .map((file) => [
        file.path,
        {
          id: file.id,
          path: file.path,
          status: file.status,
          changedLines: [],
        },
      ]),
  );

  for (const line of inventory?.changedLines || []) {
    const file = filesByPath.get(line.file);
    if (!file) {
      continue;
    }

    file.changedLines.push({
      id: line.id,
      hunkId: line.hunkId,
      kind: line.kind,
      oldLine: line.oldLine,
      newLine: line.newLine,
      content: line.content,
    });
  }

  return {
    schemaVersion: "diff-line-map/v1",
    changedLineCount: inventory?.changedLineCount || 0,
    files: [...filesByPath.values()],
  };
}

function buildMiniTreesPrompt({
  diffLineMapText,
  diffPatchText,
  fileMapText,
  metadataText,
  miniTreesPrompt,
  previousFailure,
  sharedPrompt,
}) {
  return `${sharedPrompt.trim()}

${miniTreesPrompt.trim()}
${buildRetryGuidance(previousFailure)}
${buildSourceInput({
    diffLineMapText,
    diffPatchText,
    fileMapText,
    metadataText,
  })}

Generate every changed file's one complete mini-tree as your final answer.
`;
}

function buildRetryGuidance(previousFailure) {
  return previousFailure
    ? `
## Step 07 Retry Feedback

The previous candidate reached step 07 only after step 05 validation and step
06 judging ran in numerical order. It was rejected for these reasons:

${previousFailure}

Regenerate the complete mini-tree analysis from scratch. Fix every reported
file ownership, changed-line ownership, mini-tree topology, reviewClass,
changeRole, comment, validation, or judge issue. Every changed file must appear
exactly once and every changed line must belong to exactly one node in that
file's mini-tree.
`
    : "";
}

function buildSourceInput({
  diffLineMapText,
  diffPatchText,
  fileMapText,
  metadataText,
}) {
  return `
## Inline Input

Use the inline input below. Do not call tools or read files unless the inline
patch is insufficient for semantic grouping.

### metadata.json

<metadata_json>
${metadataText}
</metadata_json>

### diff-file-map.json

<diff_file_map_json>
${fileMapText}
</diff_file_map_json>

### Changed-line map derived from diff-inventory.json

<diff_line_map_json>
${diffLineMapText}
</diff_line_map_json>

### diff.patch

<diff_patch>
${diffPatchText}
</diff_patch>
`;
}

function buildJudgePrompt({
  candidateText,
  diffLineMapText,
  diffPatchText,
  fileMapText,
  judgePrompt,
  metadataText,
  validationReport,
}) {
  return `${judgePrompt}

## Inline Input

Use the inline input below. Do not call tools or read files unless the inline
patch is insufficient for semantic judgment.

### metadata.json

<metadata_json>
${metadataText}
</metadata_json>

### diff-file-map.json

<diff_file_map_json>
${fileMapText}
</diff_file_map_json>

### Changed-line map derived from diff-inventory.json

<diff_line_map_json>
${diffLineMapText}
</diff_line_map_json>

### diff.patch

<diff_patch>
${diffPatchText}
</diff_patch>

### Step 05 validation result

<validation_result>
${validationReport}
</validation_result>

### analysis.candidate.json

<analysis_candidate_json>
${candidateText}
</analysis_candidate_json>

Judge the candidate mini-tree analysis as your final answer.
`;
}

async function runJudge({
  candidateText,
  cwd,
  diffLineMapText,
  diffPatchText,
  executeCodex,
  fileMapText,
  judgePrompt,
  metadataText,
  outputPath,
  validationReport,
}) {
  await executeCodex({
    cwd,
    outputPath,
    prompt: buildJudgePrompt({
      candidateText,
      diffLineMapText,
      diffPatchText,
      fileMapText,
      judgePrompt,
      metadataText,
      validationReport,
    }),
    schemaPath: JUDGE_SCHEMA_PATH,
  });

  return parseJsonObject(await readFile(outputPath, "utf8"));
}

async function runCodexExec({
  cwd,
  prompt,
  outputPath,
  schemaPath = MINI_TREES_SCHEMA_PATH,
}) {
  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--cd",
    cwd,
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-",
  ];

  await new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, CODEX_EXEC_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start codex: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }

      if (timedOut) {
        reject(new Error(`codex exec timed out after ${CODEX_EXEC_TIMEOUT_MS}ms.`));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      const details = summarizeCodexFailure({ stderr, stdout });
      reject(
        new Error(
          `codex exec failed with exit code ${code}${details ? `:\n${details}` : ""}`,
        ),
      );
    });

    child.stdin.end(prompt);
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
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

    throw new Error("Codex did not return a JSON object.");
  }
}

function validateJudge(judge) {
  const errors = [];

  if (judge?.schemaVersion !== "pr-graph-judge/v1") {
    errors.push("judge.json has an invalid or missing schemaVersion.");
  }

  if (judge?.verdict !== "pass" && judge?.verdict !== "fail") {
    errors.push("judge.json must use verdict pass or fail.");
  }

  if (!isNonEmptyString(judge?.summary)) {
    errors.push("judge.json must include a summary.");
  }

  if (!Array.isArray(judge?.findings)) {
    errors.push("judge.json must contain a findings array.");
  }

  if (errors.length > 0) {
    throwValidationError(errors);
  }
}

function formatJudgeFailure(judge) {
  const findings = (judge.findings || [])
    .map((finding) => {
      const target = finding.targetId ? ` ${finding.targetId}` : "";
      return `- ${finding.severity}/${finding.type}${target}: ${finding.comment}`;
    })
    .join("\n");

  return `Step 06 judge candidate failed: ${judge.summary}${findings ? `\n${findings}` : ""}`;
}

function buildValidationReport(validationFailure) {
  if (validationFailure) {
    return `FAIL\n${validationFailure}`;
  }

  return "PASS\nStep 05 deterministic mini-tree validation accepted the candidate.";
}

function formatAttemptFailure({ attempt, failures }) {
  return `Attempt ${attempt} failed after the ordered workflow stages:\n${failures.join("\n")}`;
}

function formatStageFailure(stage, error) {
  const message = error instanceof Error ? error.message : String(error);
  return `Step ${stage} failed: ${message}`;
}

function summarizeCodexFailure({ stderr, stdout }) {
  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
  const apiMessages = [...details.matchAll(/"message":\s*"([^"\n]+)"/g)];
  const apiMessage = apiMessages.at(-1)?.[1];

  if (apiMessage) {
    return apiMessage.replaceAll("\\n", "\n").replaceAll("\\\"", "\"");
  }

  return details.slice(-4000);
}

function throwValidationError(errors) {
  throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
