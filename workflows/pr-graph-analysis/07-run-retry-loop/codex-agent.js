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
const CODEX_EXEC_TIMEOUT_MS = Number(process.env.PRC_CODEX_TIMEOUT_MS || 900000);

export { validateGraphAnalysis, validateMiniTreeAnalysis };

export async function runCodexGraphAnalysis({
  executeCodex = runCodexExec,
  model,
  onEvent,
  reasoningEffort,
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

      const [sharedPrompt, miniTreesPrompt, judgePrompt] = await Promise.all([
        readFile(SHARED_PROMPT_PATH, "utf8"),
        readFile(MINI_TREES_PROMPT_PATH, "utf8"),
        readFile(JUDGE_PROMPT_PATH, "utf8"),
      ]);
      throwIfAborted(signal);
      const inventory = await readJson(path.join(resolvedRunDir, "diff-inventory.json"));
      const metadataText = await readFile(
        path.join(resolvedRunDir, "metadata.json"),
        "utf8",
      );
      const diffPatchText = await readFile(
        path.join(resolvedRunDir, "diff.patch"),
        "utf8",
      );
      const diffLineMapText = `${JSON.stringify(buildDiffLineMap(inventory))}\n`;
      const fileMapText = `${JSON.stringify(buildFileMap(inventory))}\n`;
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
            diffLineMapText,
            diffPatchText,
            emitEvent,
            executionConfig,
            executeCodex: executeCodexWithUsage,
            fileMapText,
            inventory,
            judgePrompt,
            metadataText,
            miniTreesPrompt,
            previousCandidate,
            previousEvaluation,
            previousFailure: failures.at(-1),
            resolvedRunDir,
            sharedPrompt,
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
  diffLineMapText,
  diffPatchText,
  emitEvent,
  executionConfig,
  executeCodex,
  fileMapText,
  inventory,
  judgePrompt,
  metadataText,
  miniTreesPrompt,
  previousCandidate,
  previousEvaluation,
  previousFailure,
  resolvedRunDir,
  sharedPrompt,
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
        return runJsonStage({
          cwd: resolvedRunDir,
          executionConfig,
          executeCodex,
          outputPath: artifacts.miniTreesRawPath,
          prompt: buildMiniTreesPrompt({
            diffLineMapText,
            diffPatchText,
            fileMapText,
            metadataText,
            miniTreesPrompt,
            previousFailure,
            sharedPrompt,
          }),
          promptPath: artifacts.miniTreesPromptPath,
          schemaPath: MINI_TREES_SCHEMA_PATH,
        });
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
    const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
    await writeFile(candidatePath, candidateText, "utf8");

    evaluation = await runCandidateEvaluation({
      attempt,
      attemptStageId,
      candidate,
      candidateText,
      diffLineMapText,
      diffPatchText,
      emitEvent,
      executionConfig,
      executeCodex,
      fileMapText,
      inventory,
      judgePrompt,
      metadataText,
      outputPath: artifacts.judgeRawPath,
      resolvedRunDir,
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

async function runCandidateEvaluation({
  attempt,
  attemptStageId,
  candidate,
  candidateText,
  diffLineMapText,
  diffPatchText,
  emitEvent,
  executionConfig,
  executeCodex,
  fileMapText,
  inventory,
  judgePrompt,
  metadataText,
  outputPath,
  resolvedRunDir,
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

      if (isSchemaUsableCandidate(candidate)) {
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
              ...executionMetrics(executionConfig),
              ...usageMetrics(subtractUsage(usage, judgeUsageBefore)),
            }),
            metricsForResult: (judgeResult) => ({
              findingCount: judgeResult.findings?.length || 0,
              verdict: judgeResult.verdict,
              ...executionMetrics(executionConfig),
              ...usageMetrics(subtractUsage(usage, judgeUsageBefore)),
            }),
            parentStageId: evaluationStageId,
            run: async () => {
              const judgeResult = await runJudge({
                candidateText,
                cwd: resolvedRunDir,
                diffLineMapText,
                diffPatchText,
                executionConfig,
                executeCodex,
                fileMapText,
                judgePrompt,
                metadataText,
                outputPath,
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
        judgeFailure = "Step 06 judge candidate skipped: candidate is not schema-usable.";
        await runInstrumentedStage({
          attempt,
          emitEvent,
          label: "AI semantic judge",
          metricsForResult: () => ({
            reason: "schema-unusable-candidate",
            ...executionMetrics(executionConfig),
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
        passed: validationFailure === null && judge?.verdict === "pass",
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
  const repairPayload = await runJsonStage({
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
  });

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
  const candidateText = `${JSON.stringify(candidate)}\n`;
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

  return {
    schemaVersion: "targeted-diff-input/v1",
    files: (inventory?.files || [])
      .filter((file) => hunkIdsByFileId.has(file.id))
      .map((file) => {
        const hunkIds = hunkIdsByFileId.get(file.id);
        return {
          id: file.id,
          path: file.path,
          status: file.status,
          addedLines: file.addedLines ?? 0,
          deletedLines: file.deletedLines ?? 0,
          hunks: (file.hunks || [])
            .filter((hunk) => (
              hunk.changedLineIds?.length > 0
              && (hunkIds === null || hunkIds.has(hunk.id))
            ))
            .map((hunk) => ({
              id: hunk.id,
              header: hunk.header,
              lines: (hunk.lines || []).map((line) => ({
                id: line.id,
                kind: line.kind,
                newLine: line.newLine,
                oldLine: line.oldLine,
                content: line.content,
              })),
            })),
        };
      }),
  };
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

The previous candidate reached step 07 after one combined evaluation. Step 05
deterministic validation ran first, then step 06 semantic judging inspected
every schema-usable candidate even when deterministic validation failed. It was
rejected for these combined reasons:

${previousFailure}

Regenerate the complete mini-tree analysis from scratch. Fix every reported
file ownership, changed-line ownership, mini-tree topology, reviewClass,
changeRole, comment, validation, or judge issue. Every changed file must appear
exactly once and every changed line must belong to exactly one node in that
file's mini-tree. Rewrite weak comments to explain what changed or is related
and why it matters or belongs next; leave how the implementation works to the
code attached to the node. Use Markdown bullets when the explanation has
multiple distinct points, but treat length and Markdown formatting as advisory.
Do not remove useful context merely to meet a formatting target.
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
  executionConfig,
  executeCodex,
  fileMapText,
  judgePrompt,
  metadataText,
  outputPath,
  validationReport,
}) {
  await executeCodex({
    cwd,
    ...executionConfig,
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
