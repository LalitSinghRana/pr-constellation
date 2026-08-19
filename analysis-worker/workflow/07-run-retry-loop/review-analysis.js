import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  analysisModelReasoningEffort,
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_REASONING_EFFORT,
} from "../../../shared/analysis-models.js";
import {
  isAcceptableFileTreeRoot,
  validateReviewAnalysis,
  validateReviewStacks,
} from "../05-validate-candidate/validate-analysis.js";
import { isAbortError, throwIfAborted } from "../abort.js";
import { resolveAnalysisExecutor } from "./analysis-providers.js";
import { createRunAnalysisAttempt } from "./review-analysis/candidate-generation.js";
import { createTaskLimiter } from "./review-analysis/task-limiter.js";
import { addUsage, copyUsage, emptyUsage, normalizeUsage, subtractUsage } from "./usage.js";

const WORKFLOW_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CANDIDATE_WORKFLOW_DIR = path.join(WORKFLOW_DIR, "04-generate-candidate-analysis");
const SHARED_PROMPT_PATH = path.join(CANDIDATE_WORKFLOW_DIR, "01-shared-contract", "prompt.md");
const REVIEW_TREES_PROMPT_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "03-create-review-trees",
  "prompt.md",
);
export const REVIEW_TREES_SCHEMA_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "03-create-review-trees",
  "schema.json",
);
export const FILE_TREE_SCHEMA_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "03-create-review-trees",
  "file-tree.schema.json",
);
const REVIEW_STACKS_PROMPT_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "02-create-review-stacks",
  "prompt.md",
);
const REVIEW_STACKS_SCHEMA_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "02-create-review-stacks",
  "schema.json",
);
const JUDGE_PROMPT_PATH = path.join(WORKFLOW_DIR, "06-judge-candidate", "prompt.md");
const JUDGE_SCHEMA_PATH = path.join(WORKFLOW_DIR, "06-judge-candidate", "schema.json");
const MAX_ANALYSIS_ATTEMPTS = 3;
const JUDGE_REASONING_EFFORT = "high";
const MODEL_EXECUTION_CONCURRENCY = 3;
const REVIEW_TREES_SHARD_CONCURRENCY = 3;
// ponytail: flat file-count cap per shard; an oversized stack can still
// overflow the model's context window in one call. Replace with a line/token
// budget if a smaller-but-still-oversized stack overflows.
export const MAX_FILES_PER_REVIEW_TREES_SHARD = 15;
// Retained for offline benchmarking; deterministic validation is the active gate.
const SEMANTIC_JUDGE_ENABLED = false;
const limitModelExecution = createTaskLimiter(MODEL_EXECUTION_CONCURRENCY);

export {
  computeFileTreeMetrics,
  createTaskLimiter,
  materializeLineOwnership,
  validateReviewAnalysis,
};

export async function runReviewAnalysis({
  execute,
  model,
  onEvent,
  reasoningEffort,
  runDir,
  signal,
}) {
  throwIfAborted(signal);

  const resolvedRunDir = path.resolve(runDir);
  const emitEvent = createEventEmitter(onEvent);
  const executionConfig = resolveExecutionConfig({ model, reasoningEffort });
  const judgeExecutionConfig = resolveExecutionConfig({
    model: executionConfig.model,
    reasoningEffort: JUDGE_REASONING_EFFORT,
  });
  const selectedExecute = execute || resolveAnalysisExecutor({ model: executionConfig.model });
  const usage = emptyUsage();
  const limitModelTask = createTaskLimiter(REVIEW_TREES_SHARD_CONCURRENCY);
  // Assigned inside the "Analysis" stage's run() below; metricsForResult reads it once
  // run() has resolved, so it's always populated by the time that happens.
  let inventory;
  const executeWithUsage = async (options) => {
    const executionSignal =
      signal && options.signal
        ? AbortSignal.any([signal, options.signal])
        : options.signal || signal;

    try {
      throwIfAborted(executionSignal);
      const result = await limitModelExecution(
        () => selectedExecute({ ...options, signal: executionSignal }),
        executionSignal,
      );
      addUsage(usage, normalizeUsage(result?.usage));
      throwIfAborted(executionSignal);
      return result;
    } catch (error) {
      addUsage(usage, normalizeUsage(error?.usage));
      throw error;
    }
  };

  try {
    return await runInstrumentedStage({
      emitEvent,
      label: "Analysis",
      metricsForError: () => ({
        ...executionMetrics(executionConfig),
        ...copyUsage(usage),
      }),
      metricsForResult: (result) => ({
        ...executionMetrics(executionConfig),
        ...copyUsage(usage),
        ...computeFileTreeMetrics({ analysis: result.analysis, inventory }),
      }),
      run: async () => {
        await mkdir(resolvedRunDir, { recursive: true });

        const [sharedPrompt, reviewTreesPrompt, judgePrompt, reviewStacksPrompt] =
          await Promise.all([
            readFile(SHARED_PROMPT_PATH, "utf8"),
            readFile(REVIEW_TREES_PROMPT_PATH, "utf8"),
            readFile(JUDGE_PROMPT_PATH, "utf8"),
            readFile(REVIEW_STACKS_PROMPT_PATH, "utf8"),
          ]);
        throwIfAborted(signal);
        inventory = await readJson(path.join(resolvedRunDir, "diff-inventory.json"));
        const metadataText = await readFile(path.join(resolvedRunDir, "metadata.json"), "utf8");
        const structuredDiffText = `${JSON.stringify(buildStructuredDiff(inventory))}\n`;
        const reviewStacksDocument = await runInstrumentedStage({
          emitEvent,
          label: "Review Stacks",
          metricsForResult: (document) => ({
            stackCount: document.reviewStacks.length,
          }),
          parentStageId: "analysis",
          run: async () => {
            const reviewStacksPromptPath = path.join(resolvedRunDir, "review-stacks-prompt.md");
            const reviewStacksRawPath = path.join(resolvedRunDir, "review-stacks.raw.json");
            const document = await runJsonStage({
              cwd: resolvedRunDir,
              executionConfig,
              execute: executeWithUsage,
              outputPath: reviewStacksRawPath,
              prompt: buildReviewStacksPrompt({
                inventory,
                metadataText,
                reviewStacksPrompt,
              }),
              promptPath: reviewStacksPromptPath,
              schemaPath: REVIEW_STACKS_SCHEMA_PATH,
            });
            validateReviewStacks(document, { inventory });
            await writeFile(
              path.join(resolvedRunDir, "review-stacks.json"),
              `${JSON.stringify(document, null, 2)}\n`,
              "utf8",
            );
            return document;
          },
          stageId: "analysis.review-stacks",
        });
        const analysisPath = path.join(resolvedRunDir, "analysis.json");
        const candidatePath = path.join(resolvedRunDir, "analysis.candidate.json");
        const judgePath = path.join(resolvedRunDir, "judge.json");
        const failures = [];
        let previousCandidate;
        let previousEvaluation;
        let analysis;
        let judge;
        let finalCandidateRawOutputPath;
        let finalJudgeRawOutputPath;
        let finalPromptPath;
        let rawOutputPath;

        for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt += 1) {
          throwIfAborted(signal);
          const attemptUsageBefore = copyUsage(usage);
          const attemptResult = await runInstrumentedStage({
            attempt,
            emitEvent,
            errorForResult: ({ attemptFailures }) => attemptFailures.join("\n"),
            label: `Analysis attempt ${attempt}`,
            metricsForResult: ({ attemptFailures, evaluation, repairScope, strategy }) => ({
              affectedFileCount: repairScope?.fileIds.length || 0,
              judgeVerdict: evaluation?.judge?.verdict || null,
              strategy,
              validationPassed: evaluation?.validationFailure === null,
              willRetry: attemptFailures.length > 0 && attempt < MAX_ANALYSIS_ATTEMPTS,
              ...copyUsage(subtractUsage(usage, attemptUsageBefore)),
            }),
            parentStageId: "analysis",
            run: async () =>
              runAnalysisAttempt({
                attempt,
                candidatePath,
                emitEvent,
                executionConfig,
                execute: executeWithUsage,
                inventory,
                judgeExecutionConfig,
                judgePrompt,
                limitModelTask,
                metadataText,
                reviewTreesPrompt,
                previousCandidate,
                previousEvaluation,
                previousFailure: failures.at(-1),
                resolvedRunDir,
                reviewStacks: reviewStacksDocument.reviewStacks,
                sharedPrompt,
                signal,
                structuredDiffText,
                usage,
              }),
            stageId: `analysis.attempt-${attempt}`,
            statusForResult: ({ attemptFailures }) =>
              attemptFailures.length === 0 ? "completed" : "failed",
          });

          if (attemptResult.attemptFailures.length === 0) {
            analysis = attemptResult.candidate;
            judge = attemptResult.attemptJudge;
            finalJudgeRawOutputPath = attemptResult.artifacts.judgeRawPath;
            finalPromptPath = attemptResult.promptPath;
            rawOutputPath = attemptResult.artifacts.analysisRawPath;
            finalCandidateRawOutputPath = attemptResult.candidateRawOutputPath;
            break;
          }

          const attemptFailure = formatAttemptFailure({
            attempt,
            failures: attemptResult.attemptFailures,
          });
          failures.push(attemptFailure);
          previousCandidate = attemptResult.candidate || previousCandidate;
          previousEvaluation = attemptResult.evaluation || previousEvaluation;

          if (attempt === MAX_ANALYSIS_ATTEMPTS) {
            throw new Error(
              `PR review tree analysis failed after ${MAX_ANALYSIS_ATTEMPTS} complete attempts:\n\n${failures.join("\n\n")}`,
            );
          }
        }

        throwIfAborted(signal);
        await runInstrumentedStage({
          emitEvent,
          label: "Persist final analysis artifacts",
          parentStageId: "analysis",
          run: async () => {
            await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
            await writeFile(judgePath, `${JSON.stringify(judge, null, 2)}\n`, "utf8");
          },
          stageId: "analysis.persist-artifacts",
        });

        return {
          analysis,
          analysisPath,
          candidateRawOutputPath: finalCandidateRawOutputPath,
          execution: reportedExecutionConfig(executionConfig),
          judge,
          judgePath,
          judgeRawOutputPath: finalJudgeRawOutputPath,
          promptPath: finalPromptPath,
          rawOutputPath,
          usage: copyUsage(usage),
        };
      },
      stageId: "analysis",
    });
  } catch (error) {
    if (error && typeof error === "object") {
      error.usage = copyUsage(usage);
    }
    throw error;
  }
}

export async function runCandidateEvaluation({
  attempt,
  attemptStageId,
  candidate,
  candidateText,
  emitEvent,
  execute,
  inventory,
  judgeExecutionConfig,
  judgePrompt,
  metadataText,
  outputPath,
  resolvedRunDir,
  structuredDiffText,
  usage,
}) {
  const evaluationStageId = `${attemptStageId}.evaluation`;
  const evaluationUsageBefore = copyUsage(usage);

  return runInstrumentedStage({
    attempt,
    emitEvent,
    errorForResult: ({ feedback }) => feedback.join("\n"),
    label: "Evaluation",
    metricsForResult: ({ judge, judgeSkipped, validationFailure }) => ({
      findingCount: judge?.findings?.length || 0,
      judgeSkipped,
      judgeVerdict: judge?.verdict || null,
      validationPassed: validationFailure === null,
      ...copyUsage(subtractUsage(usage, evaluationUsageBefore)),
    }),
    parentStageId: attemptStageId,
    run: async () => {
      let judge = null;
      let judgeFailure = null;
      let judgeSkipped = false;
      let validationFailure = null;

      try {
        await runInstrumentedStage({
          attempt,
          emitEvent,
          label: "Deterministic validation",
          metricsForResult: () => ({
            changedLineCount: inventory?.changedLineCount || 0,
            fileCount: inventory?.files?.length || 0,
          }),
          parentStageId: evaluationStageId,
          run: async () => validateReviewAnalysis(candidate, { inventory }),
          stageId: `${evaluationStageId}.validate-candidate`,
        });
      } catch (error) {
        validationFailure = formatStageFailure("05 validate candidate", error);
      }

      if (SEMANTIC_JUDGE_ENABLED && isSchemaUsableCandidate(candidate)) {
        const judgeUsageBefore = copyUsage(usage);
        try {
          judge = await runInstrumentedStage({
            attempt,
            emitEvent,
            errorForResult: (judgeResult) =>
              judgeResult.verdict === "pass" ? undefined : formatJudgeFailure(judgeResult),
            label: "AI semantic judge",
            metricsForError: () => ({
              ...executionMetrics(judgeExecutionConfig),
              ...copyUsage(subtractUsage(usage, judgeUsageBefore)),
            }),
            metricsForResult: (judgeResult) => ({
              findingCount: judgeResult.findings?.length || 0,
              verdict: judgeResult.verdict,
              ...executionMetrics(judgeExecutionConfig),
              ...copyUsage(subtractUsage(usage, judgeUsageBefore)),
            }),
            parentStageId: evaluationStageId,
            run: async () => {
              const judgeResult = await runJudge({
                candidateText,
                cwd: resolvedRunDir,
                executionConfig: judgeExecutionConfig,
                execute,
                judgePrompt,
                metadataText,
                outputPath,
                structuredDiffText,
                validationReport: buildValidationReport(validationFailure),
              });
              validateJudge(judgeResult);
              return judgeResult;
            },
            stageId: `${evaluationStageId}.judge-candidate`,
            statusForResult: (judgeResult) =>
              judgeResult.verdict === "pass" ? "completed" : "failed",
          });
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          judgeFailure = formatStageFailure("06 judge candidate", error);
        }
      } else {
        judgeSkipped = true;
        const skipReason = SEMANTIC_JUDGE_ENABLED
          ? "schema-unusable-candidate"
          : "semantic-judge-disabled";
        if (SEMANTIC_JUDGE_ENABLED) {
          judgeFailure = "Step 06 judge candidate skipped: candidate is not schema-usable.";
        }
        await runInstrumentedStage({
          attempt,
          emitEvent,
          label: "AI semantic judge",
          metricsForResult: () => ({
            reason: skipReason,
            ...executionMetrics(judgeExecutionConfig),
          }),
          parentStageId: evaluationStageId,
          run: async () => null,
          stageId: `${evaluationStageId}.judge-candidate`,
          statusForResult: () => "skipped",
        });
      }

      const feedback = [
        validationFailure,
        judgeFailure,
        judge?.verdict === "fail" ? formatJudgeFailure(judge) : null,
      ].filter(Boolean);

      return {
        feedback,
        judge,
        judgeFailure,
        judgeSkipped,
        passed: validationFailure === null && (judgeSkipped || judge?.verdict === "pass"),
        validationFailure,
      };
    },
    stageId: evaluationStageId,
    statusForResult: ({ passed }) => (passed ? "completed" : "failed"),
  });
}

export function buildAttemptArtifacts({ attempt, runDir }) {
  return {
    analysisRawPath: attemptArtifactPath(runDir, "analysis.raw", attempt, "json"),
    judgeRawPath: attemptArtifactPath(runDir, "judge.raw", attempt, "json"),
    reviewTreesPromptPath: attemptArtifactPath(runDir, "review-trees-prompt", attempt, "md"),
    reviewTreesRawPath: attemptArtifactPath(runDir, "review-trees.raw", attempt, "json"),
    repairPromptPath: attemptArtifactPath(runDir, "repair-prompt", attempt, "md"),
    repairRawPath: attemptArtifactPath(runDir, "repair.raw", attempt, "json"),
  };
}

function attemptArtifactPath(runDir, baseName, attempt, extension) {
  const attemptSuffix = attempt === 1 ? "" : `.attempt-${attempt}`;
  return path.join(runDir, `${baseName}${attemptSuffix}.${extension}`);
}

function createEventEmitter(onEvent) {
  if (onEvent === undefined) {
    return async () => {};
  }

  if (typeof onEvent !== "function") {
    throw new TypeError("onEvent must be a function when provided.");
  }

  return async (event) => onEvent(event);
}

export async function runInstrumentedStage({
  attempt,
  emitEvent,
  errorForResult,
  label,
  metricsForError,
  metricsForResult,
  parentStageId,
  run,
  stageId,
  statusForResult,
}) {
  const startedAt = performance.now();
  const sharedEventFields = {
    stageId,
    ...(label ? { label } : {}),
    ...(parentStageId ? { parentStageId } : {}),
    ...(attempt === undefined ? {} : { attempt }),
  };

  await emitEvent({
    type: "stage-start",
    ...sharedEventFields,
    at: new Date().toISOString(),
  });

  let result;

  try {
    result = await run();
  } catch (error) {
    await emitEvent({
      type: "stage-finish",
      ...sharedEventFields,
      at: new Date().toISOString(),
      error: formatEventError(error),
      metrics: {
        elapsedMs: elapsedMilliseconds(startedAt),
        ...(metricsForError?.(error) || {}),
      },
      status: isAbortError(error) ? "canceled" : "failed",
    });
    throw error;
  }

  const status = statusForResult?.(result) || "completed";
  const stageMetrics = metricsForResult?.(result);
  const stageError = status === "failed" ? errorForResult?.(result) : undefined;

  await emitEvent({
    type: "stage-finish",
    ...sharedEventFields,
    at: new Date().toISOString(),
    ...(stageError ? { error: stageError } : {}),
    metrics: {
      elapsedMs: elapsedMilliseconds(startedAt),
      ...(stageMetrics || {}),
    },
    status,
  });

  return result;
}

function elapsedMilliseconds(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

function formatEventError(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function runJsonStage({
  cwd,
  executionConfig,
  execute,
  outputPath,
  prompt,
  promptPath,
  schemaPath,
  signal,
}) {
  await writeFile(promptPath, prompt, "utf8");
  await execute({
    cwd,
    ...executionConfig,
    outputPath,
    prompt,
    schemaPath,
    signal,
  });

  return parseJsonObject(await readFile(outputPath, "utf8"));
}

export async function runTargetedRepair({
  candidate,
  cwd,
  evaluation,
  executionConfig,
  execute,
  inventory,
  outputPath,
  promptPath,
  repairScope,
}) {
  const repairPayload = materializeLineOwnership(
    await runJsonStage({
      cwd,
      executionConfig,
      execute,
      outputPath,
      prompt: buildTargetedRepairPrompt({
        candidate,
        evaluation,
        inventory,
        repairScope,
      }),
      promptPath,
      schemaPath: REVIEW_TREES_SCHEMA_PATH,
    }),
    { inventory },
  );

  validateRepairPayload({
    candidate,
    inventory,
    repairPayload,
    repairScope,
  });

  return mergeTargetedRepair({
    candidate,
    inventory,
    repairPayload,
  });
}

function buildTargetedRepairPrompt({ candidate, evaluation, inventory, repairScope }) {
  const affectedFileIdsText = `${JSON.stringify(repairScope.fileIds)}\n`;
  const affectedDiffText = `${JSON.stringify(
    buildAffectedDiffInput({ inventory, repairScope }),
  )}\n`;
  const candidateText = `${JSON.stringify(compactLineOwnership(candidate))}\n`;
  const feedbackText = `${JSON.stringify(buildCombinedFeedback(evaluation))}\n`;

  return `# Targeted Section Tree Repair

Repair only the Section Trees named in \`affected_file_ids\`. Return JSON that
matches the PR section tree schema, but include exactly those complete replacement
file entries in the top-level \`files\` array. Copy the current candidate's
\`intent\`, \`summary\`, and \`confidence\` values; the runner preserves the
current top-level values, File Trees, and every unaffected file. Include an
empty \`fileTree.branches\` array to satisfy the repair transport schema; the
runner discards that placeholder.

Use the combined deterministic-validation and semantic-judge feedback
together. Fix every reported issue for an affected file without changing its
inventory file id or path. Every replacement Section Tree must cover all of
that file's changed lines exactly once. Return only the repair JSON.

## Affected file ids

<affected_file_ids_json>
${affectedFileIdsText}</affected_file_ids_json>

## Combined evaluation feedback

<combined_evaluation_feedback_json>
${feedbackText}</combined_evaluation_feedback_json>

## Current complete candidate

<analysis_candidate_json>
${candidateText}</analysis_candidate_json>

## Affected file and hunk input

This is the only source input needed for the repair. It intentionally excludes
unaffected files and hunks.

<affected_diff_json>
${affectedDiffText}</affected_diff_json>

Return exactly one complete replacement entry for every affected file id and no
entry for an unaffected file.
`;
}

function buildCombinedFeedback(evaluation) {
  return {
    schemaVersion: "pr-review-evaluation-feedback/v1",
    deterministicValidation: evaluation.validationFailure
      ? {
          status: "fail",
          report: evaluation.validationFailure,
        }
      : {
          status: "pass",
          report: "Deterministic validation accepted the candidate.",
        },
    semanticJudge: evaluation.judge
      ? {
          status: evaluation.judge.verdict,
          summary: evaluation.judge.summary,
          findings: evaluation.judge.findings || [],
        }
      : {
          status: evaluation.judgeSkipped ? "skipped" : "error",
          report: evaluation.judgeFailure,
        },
  };
}

function buildAffectedDiffInput({ inventory, repairScope }) {
  const hunkIdsByFileId = new Map(
    repairScope.files.map((scopeFile) => [
      scopeFile.id,
      scopeFile.hunkIds === null ? null : new Set(scopeFile.hunkIds),
    ]),
  );

  return buildStructuredDiff(inventory, { hunkIdsByFileId });
}

export function resolveRepairScope({ candidate, evaluation, inventory }) {
  const changedFiles = (inventory?.files || []).filter((file) => file.changedLineIds?.length > 0);
  const fileById = new Map(changedFiles.map((file) => [file.id, file]));
  const fileByPath = new Map(changedFiles.map((file) => [file.path, file]));
  const hunkById = new Map();
  const lineLocationById = new Map();
  const sectionLocationsById = new Map();
  const affectedHunksByFileId = new Map();

  for (const file of changedFiles) {
    for (const hunk of file.hunks || []) {
      hunkById.set(hunk.id, { file, hunk });
      for (const line of hunk.lines || []) {
        lineLocationById.set(line.id, { file, hunk });
      }
    }
  }

  for (const candidateFile of candidate?.files || []) {
    for (const section of candidateFile?.sectionTree?.sections || []) {
      if (!isNonEmptyString(section?.id)) {
        continue;
      }
      const locations = sectionLocationsById.get(section.id) || [];
      locations.push({
        candidateFile,
        hunkIds: changedLineIdsToHunkIds(section.changedLineIds, lineLocationById),
      });
      sectionLocationsById.set(section.id, locations);
    }
  }

  const markFile = (file, hunkIds = null) => {
    if (!fileById.has(file?.id)) {
      return false;
    }

    if (hunkIds === null) {
      affectedHunksByFileId.set(file.id, null);
      return true;
    }

    if (affectedHunksByFileId.get(file.id) === null) {
      return true;
    }

    const current = affectedHunksByFileId.get(file.id) || new Set();
    for (const hunkId of hunkIds) {
      current.add(hunkId);
    }
    affectedHunksByFileId.set(file.id, current);
    return true;
  };

  const resolveIdentifier = (identifier) => {
    if (!isNonEmptyString(identifier)) {
      return false;
    }

    const file = fileById.get(identifier) || fileByPath.get(identifier);
    if (file) {
      return markFile(file);
    }

    const hunkLocation = hunkById.get(identifier);
    if (hunkLocation) {
      return markFile(hunkLocation.file, [hunkLocation.hunk.id]);
    }

    const lineLocation = lineLocationById.get(identifier);
    if (lineLocation) {
      return markFile(lineLocation.file, [lineLocation.hunk.id]);
    }

    const sectionLocations = sectionLocationsById.get(identifier);
    if (sectionLocations?.length > 0) {
      for (const location of sectionLocations) {
        const sectionFile = fileById.get(location.candidateFile.id);
        markFile(sectionFile, location.hunkIds.length > 0 ? location.hunkIds : null);
      }
      return true;
    }

    return false;
  };

  const evidence = [
    {
      targetId: "",
      text: evaluation?.validationFailure || "",
    },
    ...(evaluation?.judge?.findings || []).map((finding) => ({
      targetId: finding.targetId,
      text: finding.explanation,
    })),
  ];

  for (const item of evidence) {
    let resolvedSpecificIdentifier = resolveIdentifier(item.targetId);
    const text = item.text || "";

    for (const [lineId, location] of lineLocationById) {
      if (containsIdentifier(text, lineId)) {
        markFile(location.file, [location.hunk.id]);
        resolvedSpecificIdentifier = true;
      }
    }

    for (const [hunkId, location] of hunkById) {
      if (containsIdentifier(text, hunkId)) {
        markFile(location.file, [location.hunk.id]);
        resolvedSpecificIdentifier = true;
      }
    }

    for (const [sectionId, locations] of sectionLocationsById) {
      if (!containsIdentifier(text, sectionId)) {
        continue;
      }
      for (const location of locations) {
        const sectionFile = fileById.get(location.candidateFile.id);
        markFile(sectionFile, location.hunkIds.length > 0 ? location.hunkIds : null);
      }
      resolvedSpecificIdentifier = true;
    }

    if (resolvedSpecificIdentifier) {
      continue;
    }

    for (const file of changedFiles) {
      if (containsIdentifier(text, file.id) || (file.path && text.includes(file.path))) {
        markFile(file);
      }
    }
  }

  if (affectedHunksByFileId.size === 0) {
    return null;
  }

  const files = changedFiles
    .filter((file) => affectedHunksByFileId.has(file.id))
    .map((file) => {
      const hunkIds = affectedHunksByFileId.get(file.id);
      return {
        id: file.id,
        path: file.path,
        hunkIds: hunkIds === null ? null : [...hunkIds],
      };
    });

  return {
    fileIds: files.map((file) => file.id),
    files,
  };
}

function changedLineIdsToHunkIds(changedLineIds, lineLocationById) {
  return [
    ...new Set(
      (changedLineIds || []).map((lineId) => lineLocationById.get(lineId)?.hunk.id).filter(Boolean),
    ),
  ];
}

function containsIdentifier(text, identifier) {
  if (!text || !identifier) {
    return false;
  }

  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9:_-])${escaped}(?=$|[^A-Za-z0-9:_-])`).test(text);
}

function validateRepairPayload({ candidate, inventory, repairPayload, repairScope }) {
  const errors = [];
  const expectedIds = new Set(repairScope.fileIds);
  const replacementIds = new Set();
  const inventoryFileById = new Map((inventory?.files || []).map((file) => [file.id, file]));
  const candidateFileById = new Map((candidate?.files || []).map((file) => [file.id, file]));

  if (
    repairPayload?.schemaVersion !== "pr-review-trees/v1" ||
    !Array.isArray(repairPayload?.files)
  ) {
    errors.push("targeted repair must use pr-review-trees/v1 with a files array.");
  }

  for (const replacement of repairPayload?.files || []) {
    if (!expectedIds.has(replacement?.id)) {
      errors.push(
        `targeted repair returned unaffected or unknown file id: ${replacement?.id || "<missing>"}`,
      );
      continue;
    }
    if (replacementIds.has(replacement.id)) {
      errors.push(`targeted repair returned duplicate file id: ${replacement.id}`);
      continue;
    }
    replacementIds.add(replacement.id);

    const expectedPath =
      inventoryFileById.get(replacement.id)?.path || candidateFileById.get(replacement.id)?.path;
    if (replacement.path !== expectedPath) {
      errors.push(
        `targeted repair file ${replacement.id} path must remain ${expectedPath}; got ${replacement.path}.`,
      );
    }
  }

  for (const expectedId of expectedIds) {
    if (!replacementIds.has(expectedId)) {
      errors.push(`targeted repair omitted affected file id: ${expectedId}`);
    }
  }

  if (errors.length > 0) {
    throwValidationError(errors);
  }
}

function mergeTargetedRepair({ candidate, inventory, repairPayload }) {
  const candidateFileById = new Map((candidate.files || []).map((file) => [file.id, file]));
  const replacementFileById = new Map(repairPayload.files.map((file) => [file.id, file]));

  return {
    ...candidate,
    files: (inventory?.files || [])
      .filter((file) => file.changedLineIds?.length > 0)
      .map((file) => replacementFileById.get(file.id) || candidateFileById.get(file.id))
      .filter(Boolean),
  };
}

function isSchemaUsableCandidate(candidate) {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    candidate.schemaVersion === "pr-review-analysis/v1" &&
    Array.isArray(candidate.files) &&
    candidate.files.length > 0 &&
    candidate.files.every(
      (file) => file !== null && typeof file === "object" && !Array.isArray(file),
    )
  );
}

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

export function buildStructuredDiff(inventory, { hunkIdsByFileId = null } = {}) {
  return {
    schemaVersion: "pr-structured-diff/v1",
    changedLineCount: inventory?.changedLineCount || 0,
    files: (inventory?.files || [])
      .filter(
        (file) =>
          file.changedLineIds?.length > 0 && (!hunkIdsByFileId || hunkIdsByFileId.has(file.id)),
      )
      .map((file) => {
        const selectedHunkIds = hunkIdsByFileId?.get(file.id);
        return {
          id: file.id,
          path: file.path,
          status: file.status,
          add: file.addedLines ?? 0,
          del: file.deletedLines ?? 0,
          hunks: (file.hunks || [])
            .filter(
              (hunk) =>
                hunk.changedLineIds?.length > 0 &&
                (selectedHunkIds === undefined ||
                  selectedHunkIds === null ||
                  selectedHunkIds.has(hunk.id)),
            )
            .map((hunk) => ({
              id: hunk.id,
              header: hunk.header,
              oldStart: hunk.oldStartLine,
              newStart: hunk.newStartLine,
              lines: (hunk.lines || []).map((line) => ({
                ...(line.kind === "context" ? {} : { id: line.id }),
                kind: line.kind,
                old: line.oldLine,
                new: line.newLine,
                content: line.content,
              })),
            })),
        };
      }),
  };
}

function materializeLineOwnership(analysis, { inventory }) {
  const inventoryFileById = new Map((inventory?.files || []).map((file) => [file.id, file]));
  const inventoryFileByPath = new Map((inventory?.files || []).map((file) => [file.path, file]));
  const locations = indexChangedLineLocations(inventory);

  return {
    ...analysis,
    files: (analysis?.files || []).map((file) => {
      const inventoryFile = inventoryFileById.get(file.id) || inventoryFileByPath.get(file.path);
      if (!inventoryFile) {
        throw new Error(
          `Cannot materialize line ownership for unknown file ${file.id || file.path || "<missing>"}.`,
        );
      }

      const sections = (file.sectionTree?.sections || []).map((section) => ({
        ...section,
        changedLineIds: expandChangedLineRanges({
          file: inventoryFile,
          locations,
          section,
        }),
      }));
      const coveredIds = new Set(sections.flatMap((section) => section.changedLineIds));

      return {
        ...file,
        changedLineIds: (inventoryFile.changedLineIds || []).filter((lineId) =>
          coveredIds.has(lineId),
        ),
        sectionTree: {
          ...file.sectionTree,
          sections,
        },
      };
    }),
  };
}

function indexChangedLineLocations(inventory) {
  const locations = new Map();

  for (const [fileIndex, file] of (inventory?.files || []).entries()) {
    let fileChangedIndex = 0;
    for (const hunk of file.hunks || []) {
      const changedLineIds = hunk.changedLineIds || [];
      for (const [hunkChangedIndex, lineId] of changedLineIds.entries()) {
        locations.set(lineId, {
          fileId: file.id,
          fileIndex,
          fileChangedIndex,
          hunk,
          hunkChangedIndex,
        });
        fileChangedIndex += 1;
      }
    }
  }

  return locations;
}

function expandChangedLineRanges({ file, locations, section }) {
  if (!Array.isArray(section.changedLineRanges) || section.changedLineRanges.length === 0) {
    throw new Error(`Review section ${section.id || "<missing>"} must include changedLineRanges.`);
  }

  const expanded = [];
  let previousEndIndex = -1;

  for (const range of section.changedLineRanges) {
    const start = locations.get(range?.start);
    const end = locations.get(range?.end);
    if (!start || !end) {
      throw new Error(
        `Review section ${section.id || "<missing>"} contains an unknown changed-line range.`,
      );
    }
    if (
      start.fileId !== file.id ||
      end.fileId !== file.id ||
      start.hunk.id !== end.hunk.id ||
      start.hunkChangedIndex > end.hunkChangedIndex
    ) {
      throw new Error(
        `Review section ${section.id || "<missing>"} ranges must be forward, file-local, and stay within one hunk.`,
      );
    }
    if (start.fileChangedIndex <= previousEndIndex) {
      throw new Error(
        `Review section ${section.id || "<missing>"} ranges must be non-overlapping and in source order.`,
      );
    }

    expanded.push(
      ...start.hunk.changedLineIds.slice(start.hunkChangedIndex, end.hunkChangedIndex + 1),
    );
    previousEndIndex = end.fileChangedIndex;
  }

  return expanded;
}

export function compactLineOwnership(analysis) {
  return {
    ...analysis,
    files: (analysis?.files || []).map(({ changedLineIds, ...file }) => ({
      ...file,
      sectionTree: {
        ...file.sectionTree,
        sections: (file.sectionTree?.sections || []).map(
          ({ changedLineIds: sectionLineIds, ...section }) => section,
        ),
      },
    })),
  };
}

function buildReviewStacksPrompt({ inventory, metadataText, reviewStacksPrompt }) {
  const reviewStackDiffText = `${JSON.stringify(buildReviewStackStructuredDiff(inventory))}\n`;

  return `${reviewStacksPrompt.trim()}

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

function buildJudgePrompt({
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

async function runJudge({
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

    throw new Error("Analysis executor did not return a JSON object.");
  }
}

function validateJudge(judge) {
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

function formatJudgeFailure(judge) {
  const findings = (judge.findings || [])
    .map((finding) => {
      const target = finding.targetId ? ` ${finding.targetId}` : "";
      return `- ${finding.severity}/${finding.type}${target}: ${finding.explanation}`;
    })
    .join("\n");

  return `Step 06 judge candidate failed: ${judge.summary}${findings ? `\n${findings}` : ""}`;
}

function buildValidationReport(validationFailure) {
  if (validationFailure) {
    return `FAIL\n${validationFailure}`;
  }

  return "PASS\nStep 05 deterministic review tree validation accepted the candidate.";
}

function formatAttemptFailure({ attempt, failures }) {
  return `Attempt ${attempt} failed after the ordered workflow stages:\n${failures.join("\n")}`;
}

export function formatStageFailure(stage, error) {
  const message = error instanceof Error ? error.message : String(error);
  return `Step ${stage} failed: ${message}`;
}

function resolveExecutionConfig({ model, reasoningEffort } = {}) {
  const selectedModel =
    typeof model === "string" && model.trim() ? model.trim() : DEFAULT_ANALYSIS_MODEL;
  const selectedEffort =
    typeof reasoningEffort === "string" && reasoningEffort.trim()
      ? reasoningEffort.trim()
      : analysisModelReasoningEffort(selectedModel) || DEFAULT_ANALYSIS_REASONING_EFFORT;
  return {
    model: selectedModel,
    reasoningEffort: selectedEffort,
  };
}

function reportedExecutionConfig(executionConfig) {
  return {
    model: executionConfig.model,
    reasoningEffort: executionConfig.reasoningEffort,
  };
}

export function executionMetrics(executionConfig) {
  return reportedExecutionConfig(executionConfig);
}

function computeFileTreeMetrics({ analysis, inventory }) {
  const reviewStacks = analysis?.reviewStacks || [];
  const fileById = new Map((analysis?.files || []).map((file) => [file.id, file]));
  const inventoryOrderById = new Map(
    (inventory?.files || []).map((file, index) => [file.id, index]),
  );

  let fileTreeDepth = 0;
  let stacksWithTree = 0;
  let sourceOrderMatches = 0;
  let invalidFileTreeRootCount = 0;

  for (const stack of reviewStacks) {
    const branches = stack.fileTree?.branches;
    if (!Array.isArray(branches)) {
      continue;
    }
    stacksWithTree += 1;

    const childBranchesByParentId = new Map();
    const hasIncoming = new Set();
    for (const branch of branches) {
      const children = childBranchesByParentId.get(branch.parentId) || [];
      children.push(branch);
      childBranchesByParentId.set(branch.parentId, children);
      hasIncoming.add(branch.childId);
    }
    const rootId = (stack.fileIds || []).find((fileId) => !hasIncoming.has(fileId));

    fileTreeDepth = Math.max(fileTreeDepth, measureFileTreeDepth(rootId, childBranchesByParentId));

    const treeOrderIds = fileTreeDfsOrder(rootId, childBranchesByParentId);
    const sourceOrderIds = (stack.fileIds || [])
      .slice()
      .sort(
        (left, right) => (inventoryOrderById.get(left) ?? 0) - (inventoryOrderById.get(right) ?? 0),
      );
    if (
      treeOrderIds.length === sourceOrderIds.length &&
      treeOrderIds.every((fileId, index) => fileId === sourceOrderIds[index])
    ) {
      sourceOrderMatches += 1;
    }

    if (rootId) {
      const rootFile = fileById.get(rootId);
      const stackFiles = (stack.fileIds || [])
        .map((fileId) => fileById.get(fileId))
        .filter(Boolean);
      if (rootFile && !isAcceptableFileTreeRoot(rootFile, stackFiles)) {
        invalidFileTreeRootCount += 1;
      }
    }
  }

  return {
    invalidFileTreeRootCount,
    fileTreeDepth,
    sourceOrderMatch: stacksWithTree > 0 ? sourceOrderMatches / stacksWithTree : null,
  };
}

function measureFileTreeDepth(rootId, childBranchesByParentId) {
  if (!rootId) {
    return 0;
  }

  let maxDepth = 0;
  const visit = (fileId, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    for (const branch of childBranchesByParentId.get(fileId) || []) {
      visit(branch.childId, depth + 1);
    }
  };
  visit(rootId, 0);
  return maxDepth;
}

function fileTreeDfsOrder(rootId, childBranchesByParentId) {
  if (!rootId) {
    return [];
  }

  const order = [];
  const visit = (fileId) => {
    order.push(fileId);
    const children = (childBranchesByParentId.get(fileId) || [])
      .slice()
      .sort((left, right) => left.order - right.order);
    for (const branch of children) {
      visit(branch.childId);
    }
  };
  visit(rootId);
  return order;
}

function throwValidationError(errors) {
  throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const runAnalysisAttempt = createRunAnalysisAttempt({
  buildAttemptArtifacts,
  buildReviewTreesPrompt,
  buildStructuredDiff,
  compactLineOwnership,
  executionMetrics,
  FILE_TREE_SCHEMA_PATH,
  formatStageFailure,
  MAX_FILES_PER_REVIEW_TREES_SHARD,
  materializeLineOwnership,
  REVIEW_TREES_SCHEMA_PATH,
  resolveRepairScope,
  runCandidateEvaluation,
  runInstrumentedStage,
  runJsonStage,
  runTargetedRepair,
});
