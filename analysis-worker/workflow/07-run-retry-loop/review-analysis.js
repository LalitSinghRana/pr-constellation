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
  validateReviewAnalysis,
  validateReviewStacks,
} from "../05-validate-candidate/validate-analysis.js";
import { isAbortError, throwIfAborted } from "../abort.js";
import { resolveAnalysisExecutor } from "./analysis-providers.js";
import {
  buildReviewStacksPrompt,
  buildReviewTreesPrompt,
} from "./review-analysis/analysis-prompts.js";
import { createRunAnalysisAttempt } from "./review-analysis/candidate-generation.js";
import { computeFileTreeMetrics } from "./review-analysis/file-tree-metrics.js";
import { formatJudgeFailure, runJudge, validateJudge } from "./review-analysis/judge-candidate.js";
import {
  buildStructuredDiff,
  compactLineOwnership,
  materializeLineOwnership,
} from "./review-analysis/structured-diff.js";
import { resolveRepairScope, runTargetedRepair } from "./review-analysis/targeted-repair.js";
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
const MAX_ANALYSIS_ATTEMPTS = 3;
const MAX_REVIEW_STACKS_ATTEMPTS = 3;
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
            const reviewStacksFailures = [];
            let document;

            for (let attempt = 1; attempt <= MAX_REVIEW_STACKS_ATTEMPTS; attempt += 1) {
              throwIfAborted(signal);
              const attemptRawPath =
                attempt === 1
                  ? reviewStacksRawPath
                  : reviewStacksRawPath.replace(/\.json$/, `.attempt-${attempt}.json`);
              const attemptPromptPath =
                attempt === 1
                  ? reviewStacksPromptPath
                  : reviewStacksPromptPath.replace(/\.md$/, `.attempt-${attempt}.md`);

              try {
                document = await runJsonStage({
                  cwd: resolvedRunDir,
                  executionConfig,
                  execute: executeWithUsage,
                  outputPath: attemptRawPath,
                  prompt: buildReviewStacksPrompt({
                    inventory,
                    metadataText,
                    previousFailure: reviewStacksFailures.at(-1),
                    reviewStacksPrompt,
                  }),
                  promptPath: attemptPromptPath,
                  schemaPath: REVIEW_STACKS_SCHEMA_PATH,
                });
                validateReviewStacks(document, { inventory });
                if (attempt > 1) {
                  await writeFile(
                    reviewStacksRawPath,
                    `${JSON.stringify(document, null, 2)}\n`,
                    "utf8",
                  );
                }
                break;
              } catch (error) {
                if (isAbortError(error)) {
                  throw error;
                }
                const failure = formatStageFailure("04.2 create review stacks", error);
                reviewStacksFailures.push(failure);
                if (attempt === MAX_REVIEW_STACKS_ATTEMPTS) {
                  throw new Error(
                    `Review stack generation failed after ${MAX_REVIEW_STACKS_ATTEMPTS} attempts:\n\n${reviewStacksFailures.join("\n\n")}`,
                  );
                }
              }
            }

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
