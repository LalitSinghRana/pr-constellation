import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  createChildProcessTerminator,
  USE_DETACHED_PROCESS_GROUP,
} from "../child-process-termination.js";
import {
  validateGraphAnalysis,
  validateMiniTreeAnalysis,
  validateReviewStack,
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
const REVIEW_STACK_PROMPT_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "03-create-review-stack",
  "prompt.md",
);
const REVIEW_STACK_SCHEMA_PATH = path.join(
  CANDIDATE_WORKFLOW_DIR,
  "03-create-review-stack",
  "schema.json",
);
const JUDGE_PROMPT_PATH = path.join(WORKFLOW_DIR, "06-judge-candidate", "prompt.md");
const JUDGE_SCHEMA_PATH = path.join(WORKFLOW_DIR, "06-judge-candidate", "schema.json");
const MAX_ANALYSIS_ATTEMPTS = 3;
const CODEX_EXEC_TIMEOUT_MS = Number(process.env.PRC_CODEX_TIMEOUT_MS || 900000);
const DEFAULT_ANALYSIS_REASONING_EFFORT = "xhigh";
const JUDGE_REASONING_EFFORT = "high";
const MINI_TREES_SHARD_CONCURRENCY = 3;
// ponytail: flat file-count cap per shard; an oversized stack can still
// overflow the model's context window in one call. Replace with a line/token
// budget if a smaller-but-still-oversized stack overflows.
const MAX_FILES_PER_MINI_TREES_SHARD = 15;
// Retained for offline benchmarking; deterministic validation is the active gate.
const SEMANTIC_JUDGE_ENABLED = false;

export {
  materializeLineOwnership,
  validateGraphAnalysis,
  validateMiniTreeAnalysis,
};

export async function runCodexGraphAnalysis({
  executeCodex = runCodexExec,
  model,
  onEvent,
  reasoningEffort = DEFAULT_ANALYSIS_REASONING_EFFORT,
  runDir,
  signal,
}) {
  throwIfAborted(signal);

  const resolvedRunDir = path.resolve(runDir);
  const emitEvent = createEventEmitter(onEvent);
  const executionConfig = resolveCodexExecutionConfig({
    model,
    reasoningEffort,
  });
  const judgeExecutionConfig = resolveCodexExecutionConfig({
    model,
    reasoningEffort: JUDGE_REASONING_EFFORT,
  });
  const usage = emptyUsage();
  const executeCodexWithUsage = async (options) => {
    try {
      throwIfAborted(signal);
      const result = await executeCodex({ ...options, signal });
      addUsage(usage, normalizeUsage(result?.usage));
      throwIfAborted(signal);
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
        ...usageMetrics(usage),
      }),
      metricsForResult: () => ({
        ...executionMetrics(executionConfig),
        ...usageMetrics(usage),
      }),
      run: async () => {
      await mkdir(resolvedRunDir, { recursive: true });

      const [sharedPrompt, miniTreesPrompt, judgePrompt, reviewStackPrompt] = await Promise.all([
        readFile(SHARED_PROMPT_PATH, "utf8"),
        readFile(MINI_TREES_PROMPT_PATH, "utf8"),
        readFile(JUDGE_PROMPT_PATH, "utf8"),
        readFile(REVIEW_STACK_PROMPT_PATH, "utf8"),
      ]);
      throwIfAborted(signal);
      const inventory = await readJson(path.join(resolvedRunDir, "diff-inventory.json"));
      const metadataText = await readFile(
        path.join(resolvedRunDir, "metadata.json"),
        "utf8",
      );
      const structuredDiffText = `${JSON.stringify(buildStructuredDiff(inventory))}\n`;
      const reviewStack = await runInstrumentedStage({
        emitEvent,
        label: "Review stack",
        metricsForResult: (stack) => ({
          stackCount: stack.stacks.length,
        }),
        parentStageId: "analysis",
        run: async () => {
          const reviewStackPromptPath = path.join(resolvedRunDir, "review-stack-prompt.md");
          const reviewStackRawPath = path.join(resolvedRunDir, "review-stack.raw.json");
          const stack = await runJsonStage({
            cwd: resolvedRunDir,
            executionConfig,
            executeCodex: executeCodexWithUsage,
            outputPath: reviewStackRawPath,
            prompt: buildReviewStackPrompt({
              inventory,
              metadataText,
              reviewStackPrompt,
            }),
            promptPath: reviewStackPromptPath,
            schemaPath: REVIEW_STACK_SCHEMA_PATH,
          });
          validateReviewStack(stack, { inventory });
          await writeFile(
            path.join(resolvedRunDir, "review-stack.json"),
            `${JSON.stringify(stack, null, 2)}\n`,
            "utf8",
          );
          return stack;
        },
        stageId: "analysis.review-stack",
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
          metricsForResult: ({
            attemptFailures,
            evaluation,
            repairScope,
            strategy,
          }) => ({
            affectedFileCount: repairScope?.fileIds.length || 0,
            judgeVerdict: evaluation?.judge?.verdict || null,
            strategy,
            validationPassed: evaluation?.validationFailure === null,
            willRetry: attemptFailures.length > 0 && attempt < MAX_ANALYSIS_ATTEMPTS,
            ...usageMetrics(subtractUsage(usage, attemptUsageBefore)),
          }),
          parentStageId: "analysis",
          run: async () => runAnalysisAttempt({
            attempt,
            candidatePath,
            emitEvent,
            executionConfig,
            executeCodex: executeCodexWithUsage,
            inventory,
            judgeExecutionConfig,
            judgePrompt,
            metadataText,
            miniTreesPrompt,
            previousCandidate,
            previousEvaluation,
            previousFailure: failures.at(-1),
            resolvedRunDir,
            reviewStack,
            sharedPrompt,
            structuredDiffText,
            usage,
          }),
          stageId: `analysis.attempt-${attempt}`,
          statusForResult: ({ attemptFailures }) => (
            attemptFailures.length === 0 ? "completed" : "failed"
          ),
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
            `PR mini-tree analysis failed after ${MAX_ANALYSIS_ATTEMPTS} complete attempts:\n\n${failures.join("\n\n")}`,
          );
        }
      }

      throwIfAborted(signal);
      analysis = { ...analysis, reviewStack };
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

async function runAnalysisAttempt({
  attempt,
  candidatePath,
  emitEvent,
  executionConfig,
  executeCodex,
  inventory,
  judgeExecutionConfig,
  judgePrompt,
  metadataText,
  miniTreesPrompt,
  previousCandidate,
  previousEvaluation,
  previousFailure,
  resolvedRunDir,
  reviewStack,
  sharedPrompt,
  structuredDiffText,
  usage,
}) {
  const artifacts = buildAttemptArtifacts({ attempt, runDir: resolvedRunDir });
  const attemptFailures = [];
  const attemptStageId = `analysis.attempt-${attempt}`;
  const repairScope = attempt > 1 && previousCandidate && previousEvaluation
    ? resolveRepairScope({
        candidate: previousCandidate,
        evaluation: previousEvaluation,
        inventory,
      })
    : null;
  const strategy = attempt === 1
    ? "full-generation"
    : repairScope
      ? "targeted-repair"
      : "full-regeneration";
  const generationStageId = strategy === "targeted-repair"
    ? `${attemptStageId}.repair-mini-trees`
    : `${attemptStageId}.generate-mini-trees`;
  let attemptJudge;
  let candidate;
  let candidateRawOutputPath;
  let evaluation;
  let promptPath;
  const candidateUsageBefore = copyUsage(usage);

  try {
    candidate = await runInstrumentedStage({
      attempt,
      emitEvent,
      label: strategy === "targeted-repair"
        ? "Repair affected mini-trees"
        : "Generate mini-trees",
      metricsForError: () => ({
        affectedFileCount: repairScope?.fileIds.length || 0,
        strategy,
        ...executionMetrics(executionConfig),
        ...usageMetrics(subtractUsage(usage, candidateUsageBefore)),
      }),
      metricsForResult: () => ({
        affectedFileCount: repairScope?.fileIds.length || 0,
        strategy,
        ...executionMetrics(executionConfig),
        ...usageMetrics(subtractUsage(usage, candidateUsageBefore)),
      }),
      parentStageId: attemptStageId,
      run: async () => {
        if (strategy === "targeted-repair") {
          promptPath = artifacts.repairPromptPath;
          candidateRawOutputPath = artifacts.repairRawPath;
          return runTargetedRepair({
            candidate: previousCandidate,
            cwd: resolvedRunDir,
            evaluation: previousEvaluation,
            executionConfig,
            executeCodex,
            inventory,
            outputPath: artifacts.repairRawPath,
            promptPath: artifacts.repairPromptPath,
            repairScope,
          });
        }

        promptPath = artifacts.miniTreesPromptPath;
        candidateRawOutputPath = artifacts.miniTreesRawPath;
        const generated = reviewStack.stacks.length > 1
          ? await runShardedMiniTrees({
              artifacts,
              cwd: resolvedRunDir,
              executionConfig,
              executeCodex,
              inventory,
              metadataText,
              miniTreesPrompt,
              previousFailure,
              sharedPrompt,
              stacks: reviewStack.stacks,
            })
          : await runJsonStage({
              cwd: resolvedRunDir,
              executionConfig,
              executeCodex,
              outputPath: artifacts.miniTreesRawPath,
              prompt: buildMiniTreesPrompt({
                metadataText,
                miniTreesPrompt,
                previousFailure,
                sharedPrompt,
                structuredDiffText,
              }),
              promptPath: artifacts.miniTreesPromptPath,
              schemaPath: MINI_TREES_SCHEMA_PATH,
            });
        return materializeLineOwnership(generated, { inventory });
      },
      stageId: generationStageId,
    });
    await writeFile(
      artifacts.analysisRawPath,
      `${JSON.stringify(candidate, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    attemptFailures.push(formatStageFailure("04.2 create mini-trees", error));
  }

  if (candidate) {
    await writeFile(
      candidatePath,
      `${JSON.stringify(candidate, null, 2)}\n`,
      "utf8",
    );
    const candidateText = `${JSON.stringify(compactLineOwnership(candidate))}\n`;

    evaluation = await runCandidateEvaluation({
      attempt,
      attemptStageId,
      candidate,
      candidateText,
      emitEvent,
      executeCodex,
      inventory,
      judgeExecutionConfig,
      judgePrompt,
      metadataText,
      outputPath: artifacts.judgeRawPath,
      resolvedRunDir,
      structuredDiffText,
      usage,
    });
    attemptJudge = evaluation.judge;
    attemptFailures.push(...evaluation.feedback);
  }

  return {
    artifacts,
    attemptFailures,
    attemptJudge,
    candidate,
    candidateRawOutputPath,
    evaluation,
    promptPath,
    repairScope,
    strategy,
  };
}

async function runShardedMiniTrees({
  artifacts,
  cwd,
  executionConfig,
  executeCodex,
  inventory,
  metadataText,
  miniTreesPrompt,
  previousFailure,
  sharedPrompt,
  stacks,
}) {
  const outputBase = artifacts.miniTreesRawPath.replace(/\.json$/, "");
  const promptBase = artifacts.miniTreesPromptPath.replace(/\.md$/, "");
  const shards = buildGenerationShards(stacks, MAX_FILES_PER_MINI_TREES_SHARD);
  const results = new Array(shards.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < shards.length) {
      const index = nextIndex;
      nextIndex += 1;
      const shard = shards[index];
      const otherStacks = stacks.filter((stack) => stack.id !== shard.stack.id);
      const hunkIdsByFileId = new Map(shard.fileIds.map((fileId) => [fileId, null]));
      const structuredDiffText = `${JSON.stringify(
        buildStructuredDiff(inventory, { hunkIdsByFileId }),
      )}\n`;

      results[index] = await runJsonStage({
        cwd,
        executionConfig,
        executeCodex,
        outputPath: `${outputBase}.${shard.id}.json`,
        prompt: buildStackShardPrompt({
          metadataText,
          miniTreesPrompt,
          otherStacks,
          previousFailure,
          sharedPrompt,
          stack: { ...shard.stack, fileIds: shard.fileIds },
          structuredDiffText,
        }),
        promptPath: `${promptBase}.${shard.id}.md`,
        schemaPath: MINI_TREES_SCHEMA_PATH,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MINI_TREES_SHARD_CONCURRENCY, shards.length) }, runWorker),
  );

  const merged = {
    ...results[0],
    files: results.flatMap((result) => result.files || []),
  };

  await Promise.all([
    writeFile(artifacts.miniTreesRawPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8"),
    writeFile(
      artifacts.miniTreesPromptPath,
      `Sharded across ${shards.length} calls over ${stacks.length} review stacks: ${shards
        .map((shard) => `${shard.id} (${promptBase}.${shard.id}.md)`)
        .join(", ")}\n`,
      "utf8",
    ),
  ]);

  return merged;
}

function buildGenerationShards(stacks, maxFilesPerShard) {
  return stacks.flatMap((stack) => {
    const chunks = chunkArray(stack.fileIds, maxFilesPerShard);
    return chunks.map((fileIds, index) => ({
      fileIds,
      id: chunks.length > 1 ? `${stack.id}-${index + 1}` : stack.id,
      stack,
    }));
  });
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildStackShardPrompt({
  metadataText,
  miniTreesPrompt,
  otherStacks,
  previousFailure,
  sharedPrompt,
  stack,
  structuredDiffText,
}) {
  const basePrompt = buildMiniTreesPrompt({
    metadataText,
    miniTreesPrompt,
    previousFailure,
    sharedPrompt,
    structuredDiffText,
  });
  const scopeInstruction = `## Review-Stack Scope

This call is restricted to the "${stack.title}" review stack
(${stack.fileIds.length} file${stack.fileIds.length === 1 ? "" : "s"}). The
structured diff below is the complete and exclusive source scope for this
call; return exactly one \`files[]\` entry for each of its files and no
others.

The top-level \`intent\`, \`summary\`, and \`confidence\` still describe the
whole pull request, not only this stack.

Other review stacks are covered by separate calls and exist here for
reference only, so you know what you are not responsible for: ${
    otherStacks.length > 0 ? otherStacks.map((other) => `"${other.title}"`).join(", ") : "none"
  }.

`;
  const inlineInputHeading = "## Inline Input";
  const insertAt = basePrompt.indexOf(inlineInputHeading);
  if (insertAt < 0) {
    throw new Error("Mini-tree prompt is missing its Inline Input heading.");
  }
  return `${basePrompt.slice(0, insertAt)}${scopeInstruction}${basePrompt.slice(insertAt)}`;
}

async function runCandidateEvaluation({
  attempt,
  attemptStageId,
  candidate,
  candidateText,
  emitEvent,
  executeCodex,
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
      ...usageMetrics(subtractUsage(usage, evaluationUsageBefore)),
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
          run: async () => validateMiniTreeAnalysis(candidate, { inventory }),
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
            errorForResult: (judgeResult) => (
              judgeResult.verdict === "pass"
                ? undefined
                : formatJudgeFailure(judgeResult)
            ),
            label: "AI semantic judge",
            metricsForError: () => ({
              ...executionMetrics(judgeExecutionConfig),
              ...usageMetrics(subtractUsage(usage, judgeUsageBefore)),
            }),
            metricsForResult: (judgeResult) => ({
              findingCount: judgeResult.findings?.length || 0,
              verdict: judgeResult.verdict,
              ...executionMetrics(judgeExecutionConfig),
              ...usageMetrics(subtractUsage(usage, judgeUsageBefore)),
            }),
            parentStageId: evaluationStageId,
            run: async () => {
              const judgeResult = await runJudge({
                candidateText,
                cwd: resolvedRunDir,
                executionConfig: judgeExecutionConfig,
                executeCodex,
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
            statusForResult: (judgeResult) => (
              judgeResult.verdict === "pass" ? "completed" : "failed"
            ),
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
        passed: validationFailure === null && (
          judgeSkipped || judge?.verdict === "pass"
        ),
        validationFailure,
      };
    },
    stageId: evaluationStageId,
    statusForResult: ({ passed }) => (passed ? "completed" : "failed"),
  });
}

function buildAttemptArtifacts({ attempt, runDir }) {
  return {
    analysisRawPath: attemptArtifactPath(runDir, "analysis.raw", attempt, "json"),
    judgeRawPath: attemptArtifactPath(runDir, "judge.raw", attempt, "json"),
    miniTreesPromptPath: attemptArtifactPath(runDir, "mini-trees-prompt", attempt, "md"),
    miniTreesRawPath: attemptArtifactPath(runDir, "mini-trees.raw", attempt, "json"),
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

async function runInstrumentedStage({
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

async function runJsonStage({
  cwd,
  executionConfig,
  executeCodex,
  outputPath,
  prompt,
  promptPath,
  schemaPath,
}) {
  await writeFile(promptPath, prompt, "utf8");
  await executeCodex({
    cwd,
    ...executionConfig,
    outputPath,
    prompt,
    schemaPath,
  });

  return parseJsonObject(await readFile(outputPath, "utf8"));
}

async function runTargetedRepair({
  candidate,
  cwd,
  evaluation,
  executionConfig,
  executeCodex,
  inventory,
  outputPath,
  promptPath,
  repairScope,
}) {
  const repairPayload = materializeLineOwnership(await runJsonStage({
    cwd,
    executionConfig,
    executeCodex,
    outputPath,
    prompt: buildTargetedRepairPrompt({
      candidate,
      evaluation,
      inventory,
      repairScope,
    }),
    promptPath,
    schemaPath: MINI_TREES_SCHEMA_PATH,
  }), { inventory });

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

function buildTargetedRepairPrompt({
  candidate,
  evaluation,
  inventory,
  repairScope,
}) {
  const affectedFileIdsText = `${JSON.stringify(repairScope.fileIds)}\n`;
  const affectedDiffText = `${JSON.stringify(
    buildAffectedDiffInput({ inventory, repairScope }),
  )}\n`;
  const candidateText = `${JSON.stringify(compactLineOwnership(candidate))}\n`;
  const feedbackText = `${JSON.stringify(buildCombinedFeedback(evaluation))}\n`;

  return `# Targeted PR Mini-Tree Repair

Repair only the file mini-trees named in \`affected_file_ids\`. Return JSON that
matches the PR mini-tree schema, but include exactly those complete replacement
file entries in the top-level \`files\` array. Copy the current candidate's
\`intent\`, \`summary\`, and \`confidence\` values; the runner preserves the
current top-level values and every unaffected file.

Use the combined deterministic-validation and semantic-judge feedback
together. Fix every reported issue for an affected file without changing its
inventory file id or path. Every replacement file mini-tree must cover all of
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
    schemaVersion: "pr-graph-evaluation-feedback/v1",
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

function resolveRepairScope({ candidate, evaluation, inventory }) {
  const changedFiles = (inventory?.files || []).filter(
    (file) => file.changedLineIds?.length > 0,
  );
  const fileById = new Map(changedFiles.map((file) => [file.id, file]));
  const fileByPath = new Map(changedFiles.map((file) => [file.path, file]));
  const hunkById = new Map();
  const lineLocationById = new Map();
  const nodeLocationsById = new Map();
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
    for (const node of candidateFile?.miniTree?.nodes || []) {
      if (!isNonEmptyString(node?.id)) {
        continue;
      }
      const locations = nodeLocationsById.get(node.id) || [];
      locations.push({
        candidateFile,
        hunkIds: changedLineIdsToHunkIds(node.changedLineIds, lineLocationById),
      });
      nodeLocationsById.set(node.id, locations);
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

    const nodeLocations = nodeLocationsById.get(identifier);
    if (nodeLocations?.length > 0) {
      for (const location of nodeLocations) {
        const nodeFile = fileById.get(location.candidateFile.id);
        markFile(
          nodeFile,
          location.hunkIds.length > 0 ? location.hunkIds : null,
        );
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
      text: finding.comment,
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

    for (const [nodeId, locations] of nodeLocationsById) {
      if (!containsIdentifier(text, nodeId)) {
        continue;
      }
      for (const location of locations) {
        const nodeFile = fileById.get(location.candidateFile.id);
        markFile(
          nodeFile,
          location.hunkIds.length > 0 ? location.hunkIds : null,
        );
      }
      resolvedSpecificIdentifier = true;
    }

    if (resolvedSpecificIdentifier) {
      continue;
    }

    for (const file of changedFiles) {
      if (
        containsIdentifier(text, file.id)
        || (file.path && text.includes(file.path))
      ) {
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
      (changedLineIds || [])
        .map((lineId) => lineLocationById.get(lineId)?.hunk.id)
        .filter(Boolean),
    ),
  ];
}

function containsIdentifier(text, identifier) {
  if (!text || !identifier) {
    return false;
  }

  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^A-Za-z0-9:_-])${escaped}(?=$|[^A-Za-z0-9:_-])`,
  ).test(text);
}

function validateRepairPayload({
  candidate,
  inventory,
  repairPayload,
  repairScope,
}) {
  const errors = [];
  const expectedIds = new Set(repairScope.fileIds);
  const replacementIds = new Set();
  const inventoryFileById = new Map(
    (inventory?.files || []).map((file) => [file.id, file]),
  );
  const candidateFileById = new Map(
    (candidate?.files || []).map((file) => [file.id, file]),
  );

  if (
    repairPayload?.schemaVersion !== "pr-graph-mini-trees/v2"
    || !Array.isArray(repairPayload?.files)
  ) {
    errors.push("targeted repair must use pr-graph-mini-trees/v2 with a files array.");
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

    const expectedPath = inventoryFileById.get(replacement.id)?.path
      || candidateFileById.get(replacement.id)?.path;
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
  const candidateFileById = new Map(
    (candidate.files || []).map((file) => [file.id, file]),
  );
  const replacementFileById = new Map(
    repairPayload.files.map((file) => [file.id, file]),
  );

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
    candidate !== null
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && (
      candidate.schemaVersion === "pr-graph-mini-trees/v1"
      || candidate.schemaVersion === "pr-graph-mini-trees/v2"
    )
    && Array.isArray(candidate.files)
    && candidate.files.length > 0
    && candidate.files.every((file) => (
      file !== null && typeof file === "object" && !Array.isArray(file)
    ))
  );
}

// The full structured diff (buildStructuredDiff) carries a per-line id/old/new
// line-number object for every line, which the review-stack schema never
// references (its output is just file ids grouped into stacks). For a large,
// multi-PR fixture that per-line bookkeeping alone pushed a single prompt past
// codex's 1,048,576-character input cap. This lean variant keeps every file's
// full code content but drops the ids/line-numbers the review-stack decision
// doesn't need, cutting a real fixture's prompt from ~1.42M to ~0.5M chars.
function buildReviewStackStructuredDiff(inventory) {
  return {
    schemaVersion: "pr-graph-review-stack-diff/v1",
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
            lines: (hunk.lines || []).map((line) => (
              `${line.kind === "insert" ? "+" : line.kind === "delete" ? "-" : " "}${line.content}`
            )),
          })),
      })),
  };
}

function buildStructuredDiff(inventory, { hunkIdsByFileId = null } = {}) {
  return {
    schemaVersion: "pr-graph-structured-diff/v1",
    changedLineCount: inventory?.changedLineCount || 0,
    files: (inventory?.files || [])
      .filter((file) => (
        file.changedLineIds?.length > 0
        && (!hunkIdsByFileId || hunkIdsByFileId.has(file.id))
      ))
      .map((file) => {
        const selectedHunkIds = hunkIdsByFileId?.get(file.id);
        return {
          id: file.id,
          path: file.path,
          status: file.status,
          add: file.addedLines ?? 0,
          del: file.deletedLines ?? 0,
          hunks: (file.hunks || [])
            .filter((hunk) => (
              hunk.changedLineIds?.length > 0
              && (
                selectedHunkIds === undefined
                || selectedHunkIds === null
                || selectedHunkIds.has(hunk.id)
              )
            ))
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
  const inventoryFileById = new Map(
    (inventory?.files || []).map((file) => [file.id, file]),
  );
  const inventoryFileByPath = new Map(
    (inventory?.files || []).map((file) => [file.path, file]),
  );
  const locations = indexChangedLineLocations(inventory);

  return {
    ...analysis,
    files: (analysis?.files || []).map((file) => {
      const inventoryFile = inventoryFileById.get(file.id)
        || inventoryFileByPath.get(file.path);
      if (!inventoryFile) {
        throw new Error(
          `Cannot materialize line ownership for unknown file ${file.id || file.path || "<missing>"}.`,
        );
      }

      const nodes = (file.miniTree?.nodes || []).map((node) => ({
        ...node,
        changedLineIds: expandChangedLineRanges({
          file: inventoryFile,
          locations,
          node,
        }),
      }));
      const coveredIds = new Set(
        nodes.flatMap((node) => node.changedLineIds),
      );

      return {
        ...file,
        codeRefs: {
          fileIds: [inventoryFile.id],
          changedLineIds: (inventoryFile.changedLineIds || []).filter(
            (lineId) => coveredIds.has(lineId),
          ),
        },
        miniTree: {
          ...file.miniTree,
          nodes,
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

function expandChangedLineRanges({ file, locations, node }) {
  if (!Array.isArray(node.changedLineRanges) || node.changedLineRanges.length === 0) {
    throw new Error(
      `Mini-node ${node.id || "<missing>"} must include changedLineRanges.`,
    );
  }

  const expanded = [];
  let previousEndIndex = -1;

  for (const range of node.changedLineRanges) {
    const start = locations.get(range?.start);
    const end = locations.get(range?.end);
    if (!start || !end) {
      throw new Error(
        `Mini-node ${node.id || "<missing>"} contains an unknown changed-line range.`,
      );
    }
    if (
      start.fileId !== file.id
      || end.fileId !== file.id
      || start.hunk.id !== end.hunk.id
      || start.hunkChangedIndex > end.hunkChangedIndex
    ) {
      throw new Error(
        `Mini-node ${node.id || "<missing>"} ranges must be forward, file-local, and stay within one hunk.`,
      );
    }
    if (start.fileChangedIndex <= previousEndIndex) {
      throw new Error(
        `Mini-node ${node.id || "<missing>"} ranges must be non-overlapping and in source order.`,
      );
    }

    expanded.push(
      ...start.hunk.changedLineIds.slice(
        start.hunkChangedIndex,
        end.hunkChangedIndex + 1,
      ),
    );
    previousEndIndex = end.fileChangedIndex;
  }

  return expanded;
}

function compactLineOwnership(analysis) {
  return {
    ...analysis,
    files: (analysis?.files || []).map(({ codeRefs, ...file }) => ({
      ...file,
      miniTree: {
        ...file.miniTree,
        nodes: (file.miniTree?.nodes || []).map(
          ({ changedLineIds, ...node }) => node,
        ),
      },
    })),
  };
}

function buildReviewStackPrompt({ inventory, metadataText, reviewStackPrompt }) {
  const reviewStackDiffText = `${JSON.stringify(buildReviewStackStructuredDiff(inventory))}\n`;

  return `${reviewStackPrompt.trim()}

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

function buildMiniTreesPrompt({
  metadataText,
  miniTreesPrompt,
  previousFailure,
  sharedPrompt,
  structuredDiffText,
}) {
  return `${sharedPrompt.trim()}

${miniTreesPrompt.trim()}
${buildRetryGuidance(previousFailure)}
${buildSourceInput({
    metadataText,
    structuredDiffText,
  })}

Generate every changed file's one complete mini-tree as your final answer.
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

Regenerate the complete mini-tree analysis from scratch and fix every reported
issue while following the authoritative shared contract above.
`
    : "";
}

function buildSourceInput({
  metadataText,
  structuredDiffText,
}) {
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

Judge the candidate mini-tree analysis as your final answer.
`;
}

async function runJudge({
  candidateText,
  cwd,
  executionConfig,
  executeCodex,
  judgePrompt,
  metadataText,
  outputPath,
  structuredDiffText,
  validationReport,
}) {
  await executeCodex({
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

export function resolveCodexExecutionConfig({
  env = process.env,
  model,
  reasoningEffort,
} = {}) {
  return {
    model: resolveSelectedString({
      envValue: env.PRC_CODEX_MODEL,
      label: "model",
      value: model,
    }),
    reasoningEffort: resolveSelectedString({
      envValue: env.PRC_CODEX_REASONING_EFFORT,
      label: "reasoningEffort",
      value: reasoningEffort,
    }),
  };
}

export function buildCodexExecArgs({
  cwd,
  model,
  outputPath,
  reasoningEffort,
  schemaPath = MINI_TREES_SCHEMA_PATH,
}) {
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--sandbox",
    "read-only",
    "--cd",
    cwd,
    "--color",
    "never",
    ...(model ? ["--model", model] : []),
    ...(reasoningEffort
      ? ["--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
      : []),
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-",
  ];
}

export function parseCodexJsonUsage(stdout) {
  const usage = emptyUsage();

  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.type === "turn.completed") {
      addUsage(usage, normalizeUsage(event.usage));
    }
  }

  return usage;
}

export async function runCodexExec({
  cwd,
  model,
  prompt,
  outputPath,
  reasoningEffort,
  schemaPath = MINI_TREES_SCHEMA_PATH,
  signal,
}) {
  throwIfAborted(signal);

  const args = buildCodexExecArgs({
    cwd,
    model,
    outputPath,
    reasoningEffort,
    schemaPath,
  });

  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd,
      detached: USE_DETACHED_PROCESS_GROUP,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminator = createChildProcessTerminator(child);

    let aborted = false;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      aborted = true;
      clearTimeout(timeoutTimer);
      terminator.terminate();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminator.terminate();
    }, CODEX_EXEC_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      if (child.pid) {
        return;
      }
      terminator.childClosed();
      if (aborted || signal?.aborted) {
        rejectOnce(createCodexAbortError(signal?.reason, stdout));
        return;
      }
      rejectOnce(createCodexExecError(
        `Failed to start codex: ${error.message}`,
        stdout,
      ));
    });

    child.on("close", async (code) => {
      clearTimeout(timeoutTimer);
      terminator.childClosed();
      await terminator.waitForTreeExit();

      if (settled) {
        return;
      }

      if (aborted || signal?.aborted) {
        rejectOnce(createCodexAbortError(signal?.reason, stdout));
        return;
      }

      if (timedOut) {
        rejectOnce(createCodexExecError(
          `codex exec timed out after ${CODEX_EXEC_TIMEOUT_MS}ms.`,
          stdout,
        ));
        return;
      }

      if (code === 0) {
        resolveOnce({
          usage: parseCodexJsonUsage(stdout),
        });
        return;
      }

      const details = summarizeCodexFailure({ stderr, stdout });
      rejectOnce(createCodexExecError(
        `codex exec failed with exit code ${code}${details ? `:\n${details}` : ""}`,
        stdout,
      ));
    });

    child.stdin.on("error", () => {
      // Process termination is reported through the child close/error handlers.
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child.stdin.end(prompt);
  });
}

function createCodexAbortError(reason, stdout) {
  const error = createAbortError(reason);
  error.usage = parseCodexJsonUsage(stdout);
  return error;
}

function createCodexExecError(message, stdout) {
  const error = new Error(message);
  error.usage = parseCodexJsonUsage(stdout);
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }

  throw createAbortError(signal.reason);
}

function createAbortError(reason) {
  const message = reason instanceof Error && reason.message
    ? reason.message
    : "The operation was aborted.";
  const error = new Error(message, reason === undefined ? undefined : { cause: reason });
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
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

  if (
    typeof judge?.confidence !== "number"
    || !Number.isFinite(judge.confidence)
    || judge.confidence < 0
    || judge.confidence > 1
  ) {
    errors.push("judge.json confidence must be a number from 0 to 1.");
  }

  if (!Array.isArray(judge?.findings)) {
    errors.push("judge.json must contain a findings array.");
  } else {
    for (const [index, finding] of judge.findings.entries()) {
      if (!isNonEmptyString(finding?.comment)) {
        errors.push(
          `judge.json finding ${index + 1} must include a non-empty comment.`,
        );
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

function resolveSelectedString({ envValue, label, value }) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError(`${label} must be a string when provided.`);
  }

  const explicitValue = typeof value === "string" ? value.trim() : "";
  const fallbackValue = typeof envValue === "string" ? envValue.trim() : "";
  return explicitValue || fallbackValue || undefined;
}

function reportedExecutionConfig(executionConfig) {
  return {
    model: executionConfig.model || "Codex CLI default",
    reasoningEffort:
      executionConfig.reasoningEffort || "Codex CLI default",
  };
}

function executionMetrics(executionConfig) {
  return reportedExecutionConfig(executionConfig);
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") {
    return emptyUsage();
  }

  const inputTokens = nonNegativeNumber(
    value.inputTokens ?? value.input_tokens,
  );
  const cachedInputTokens = nonNegativeNumber(
    value.cachedInputTokens ?? value.cached_input_tokens,
  );
  const outputTokens = nonNegativeNumber(
    value.outputTokens ?? value.output_tokens,
  );

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: nonNegativeNumber(
      value.totalTokens ?? value.total_tokens,
      inputTokens + outputTokens,
    ),
  };
}

function nonNegativeNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function addUsage(target, increment) {
  target.inputTokens += increment.inputTokens;
  target.cachedInputTokens += increment.cachedInputTokens;
  target.outputTokens += increment.outputTokens;
  target.totalTokens += increment.totalTokens;
  return target;
}

function copyUsage(value) {
  return {
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  };
}

function subtractUsage(value, baseline) {
  return {
    inputTokens: Math.max(0, value.inputTokens - baseline.inputTokens),
    cachedInputTokens: Math.max(
      0,
      value.cachedInputTokens - baseline.cachedInputTokens,
    ),
    outputTokens: Math.max(0, value.outputTokens - baseline.outputTokens),
    totalTokens: Math.max(0, value.totalTokens - baseline.totalTokens),
  };
}

function usageMetrics(usage) {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function throwValidationError(errors) {
  throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
