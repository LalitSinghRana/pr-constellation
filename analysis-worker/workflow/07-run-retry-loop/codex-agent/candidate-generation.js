import { writeFile } from "node:fs/promises";
import { isAbortError } from "../../abort.js";
import { copyUsage, subtractUsage } from "../usage.js";
import { runCancelableFanout } from "./task-limiter.js";

export function createRunAnalysisAttempt({
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
}) {
  return async function runAnalysisAttempt({
    attempt,
    candidatePath,
    emitEvent,
    executionConfig,
    executeCodex,
    inventory,
    judgeExecutionConfig,
    judgePrompt,
    limitModelTask,
    metadataText,
    reviewTreesPrompt,
    previousCandidate,
    previousEvaluation,
    previousFailure,
    resolvedRunDir,
    reviewStacks,
    sharedPrompt,
    signal,
    structuredDiffText,
    usage,
  }) {
    const artifacts = buildAttemptArtifacts({ attempt, runDir: resolvedRunDir });
    const attemptFailures = [];
    const attemptStageId = `analysis.attempt-${attempt}`;
    const repairScope =
      attempt > 1 && previousCandidate && previousEvaluation
        ? resolveRepairScope({
            candidate: previousCandidate,
            evaluation: previousEvaluation,
            inventory,
          })
        : null;
    const strategy =
      attempt === 1 ? "full-generation" : repairScope ? "targeted-repair" : "full-regeneration";
    const generationStageId =
      strategy === "targeted-repair"
        ? `${attemptStageId}.repair-section-trees`
        : `${attemptStageId}.generate-review-trees`;
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
        label:
          strategy === "targeted-repair"
            ? "Repair affected Section Trees"
            : "Generate review trees",
        metricsForError: () => ({
          affectedFileCount: repairScope?.fileIds.length || 0,
          strategy,
          ...executionMetrics(executionConfig),
          ...copyUsage(subtractUsage(usage, candidateUsageBefore)),
        }),
        metricsForResult: () => ({
          affectedFileCount: repairScope?.fileIds.length || 0,
          strategy,
          ...executionMetrics(executionConfig),
          ...copyUsage(subtractUsage(usage, candidateUsageBefore)),
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

          promptPath = artifacts.reviewTreesPromptPath;
          candidateRawOutputPath = artifacts.reviewTreesRawPath;
          const shards = buildGenerationShards(reviewStacks, MAX_FILES_PER_REVIEW_TREES_SHARD);
          const generated =
            shards.length > 1
              ? await runShardedReviewTrees({
                  artifacts,
                  cwd: resolvedRunDir,
                  executionConfig,
                  executeCodex,
                  inventory,
                  limitModelTask,
                  metadataText,
                  reviewTreesPrompt,
                  previousFailure,
                  shards,
                  sharedPrompt,
                  signal,
                  reviewStacks,
                })
              : await runJsonStage({
                  cwd: resolvedRunDir,
                  executionConfig,
                  executeCodex,
                  outputPath: artifacts.reviewTreesRawPath,
                  prompt: buildReviewTreesPrompt({
                    metadataText,
                    reviewTreesPrompt,
                    previousFailure,
                    sharedPrompt,
                    structuredDiffText,
                  }),
                  promptPath: artifacts.reviewTreesPromptPath,
                  schemaPath: REVIEW_TREES_SCHEMA_PATH,
                }).then((result) =>
                  assembleReviewAnalysis({
                    generated: result,
                    reviewStacks,
                  }),
                );
          return materializeLineOwnership(generated, { inventory });
        },
        stageId: generationStageId,
      });
      await writeFile(artifacts.analysisRawPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      attemptFailures.push(formatStageFailure("04.3 create review trees", error));
    }

    if (candidate) {
      await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
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
  };

  async function runShardedReviewTrees({
    artifacts,
    cwd,
    executionConfig,
    executeCodex,
    inventory,
    limitModelTask,
    metadataText,
    reviewTreesPrompt,
    previousFailure,
    shards,
    sharedPrompt,
    signal,
    reviewStacks,
  }) {
    const outputBase = artifacts.reviewTreesRawPath.replace(/\.json$/, "");
    const promptBase = artifacts.reviewTreesPromptPath.replace(/\.md$/, "");
    const results = await runCancelableFanout({
      limitTask: limitModelTask,
      signal,
      tasks: shards.map((shard) => async (taskSignal) => {
        const otherStacks = reviewStacks.filter((stack) => stack.id !== shard.stack.id);
        const hunkIdsByFileId = new Map(shard.fileIds.map((fileId) => [fileId, null]));
        const structuredDiffText = `${JSON.stringify(
          buildStructuredDiff(inventory, { hunkIdsByFileId }),
        )}\n`;

        return runJsonStage({
          cwd,
          executionConfig,
          executeCodex,
          outputPath: `${outputBase}.${shard.id}.json`,
          prompt: buildStackShardPrompt({
            metadataText,
            reviewTreesPrompt,
            otherStacks,
            previousFailure,
            sharedPrompt,
            stack: { ...shard.stack, fileIds: shard.fileIds },
            structuredDiffText,
          }),
          promptPath: `${promptBase}.${shard.id}.md`,
          schemaPath: REVIEW_TREES_SCHEMA_PATH,
          signal: taskSignal,
        });
      }),
    });

    const shardIndicesByStackId = new Map();
    shards.forEach((shard, index) => {
      const indices = shardIndicesByStackId.get(shard.stack.id) || [];
      indices.push(index);
      shardIndicesByStackId.set(shard.stack.id, indices);
    });

    const fileTrees = new Map();
    const fileTreeTasks = [];
    for (const [stackId, indices] of shardIndicesByStackId) {
      if (indices.length === 1 && results[indices[0]]?.fileTree) {
        fileTrees.set(stackId, results[indices[0]].fileTree);
        continue;
      }

      const stack = reviewStacks.find((candidate) => candidate.id === stackId);
      const stackFileIds = new Set(stack.fileIds);
      const files = results
        .flatMap((result) => result.files || [])
        .filter((file) => stackFileIds.has(file.id));
      fileTreeTasks.push(async (taskSignal) => [
        stackId,
        await runJsonStage({
          cwd,
          executionConfig,
          executeCodex,
          outputPath: `${outputBase}.file-tree.${stackId}.json`,
          prompt: buildFileTreePrompt({ files, metadataText, previousFailure, stack }),
          promptPath: `${promptBase}.file-tree.${stackId}.md`,
          schemaPath: FILE_TREE_SCHEMA_PATH,
          signal: taskSignal,
        }),
      ]);
    }

    const generatedFileTrees = await runCancelableFanout({
      limitTask: limitModelTask,
      signal,
      tasks: fileTreeTasks,
    });
    for (const [stackId, fileTree] of generatedFileTrees) {
      fileTrees.set(stackId, fileTree);
    }

    const { fileTree: _discardedShardTree, ...firstResult } = results[0];
    const merged = {
      ...firstResult,
      schemaVersion: "pr-review-analysis/v1",
      reviewStacks: reviewStacks.map((stack) => ({
        ...stack,
        fileTree: fileTrees.get(stack.id),
      })),
      files: results.flatMap((result) => result.files || []),
    };

    await Promise.all([
      writeFile(artifacts.reviewTreesRawPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8"),
      writeFile(
        artifacts.reviewTreesPromptPath,
        `Sharded across ${shards.length} calls over ${reviewStacks.length} review stacks: ${shards
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

  function assembleReviewAnalysis({ generated, reviewStacks }) {
    const { fileTree, ...analysisFields } = generated;
    return {
      ...analysisFields,
      schemaVersion: "pr-review-analysis/v1",
      reviewStacks: reviewStacks.map((stack) => ({
        ...stack,
        fileTree,
      })),
    };
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
    reviewTreesPrompt,
    otherStacks,
    previousFailure,
    sharedPrompt,
    stack,
    structuredDiffText,
  }) {
    const basePrompt = buildReviewTreesPrompt({
      metadataText,
      reviewTreesPrompt,
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
      throw new Error("Review trees prompt is missing its Inline Input heading.");
    }
    return `${basePrompt.slice(0, insertAt)}${scopeInstruction}${basePrompt.slice(insertAt)}`;
  }

  function buildFileTreePrompt({ files, metadataText, previousFailure, stack }) {
    const fileSummaries = files.map((file) => ({
      id: file.id,
      path: file.path,
      reviewPriority: file.reviewPriority,
      changeKind: file.changeKind,
      explanation: file.explanation,
      sections: (file.sectionTree?.sections || []).map((section) => ({
        title: section.title,
        reviewPriority: section.reviewPriority,
        changeKind: section.changeKind,
        explanation: section.explanation,
      })),
    }));

    return `# File Tree

Decide the file-to-file review order for the complete "${stack.title}" review
stack. The Section Trees were generated in smaller shards, so this call must join
all ${stack.fileIds.length} files into one rooted review-causality tree.

- The parent is the reason to review first; the child was caused, enabled,
  required, or made necessary by that parent. This is review causality, not
  import direction.
- Do not order by file path, directory, or input order.
- Every file appears exactly once as \`childId\`, except the single root, which never
  appears as \`childId\`. Every non-root has exactly one parent.
- Prefer a \`primary\` file over \`secondary\` over \`skim\` for the
  root, and \`runtime\` over tests, snapshots, generated files, and other
  secondary roles when those priorities differ.
- Use contiguous \`order\` values starting at 0 for each parent's children.
- Return only JSON matching the supplied schema.
${previousFailure ? `\nThe previous attempt failed validation. Correct any relevant File Tree issue:\n\n${previousFailure}\n` : ""}
## Pull request

<metadata_json>
${metadataText}
</metadata_json>

## Review stack

<review_stack_json>
${JSON.stringify(stack)}
</review_stack_json>

## Files and generated Section Tree summaries

<files_json>
${JSON.stringify(fileSummaries)}
</files_json>
`;
  }
}
