import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ANALYSIS_MODEL,
  inferAnalysisProvider,
  normalizeAnalysisProvider,
} from "../shared/analysis-models.js";
import { fetchPullRequest, parseGitHubPrUrl } from "./workflow/02-fetch-pr/github.js";
import {
  createDiffInventory,
  createDiffSummary,
} from "./workflow/03-build-diff-inventory/diff-inventory.js";
import { resolveAnalysisExecutor } from "./workflow/07-run-retry-loop/analysis-providers.js";
import { runReviewAnalysis } from "./workflow/07-run-retry-loop/review-analysis.js";
import { isAbortError, throwIfAborted } from "./workflow/abort.js";

export async function createReviewRun({ prUrl, reviewsDir }) {
  const { paths, runDir } = await createPrInputRun({ prUrl, reviewsDir });

  return {
    diffPath: paths.diffPath,
    diffInventoryPath: paths.diffInventoryPath,
    diffSummaryPath: paths.diffSummaryPath,
    metadataPath: paths.metadataPath,
    runDir,
  };
}

export async function createAnalysisRun({ prUrl, reviewsDir }) {
  const { paths, runDir } = await createPrInputRun({ prUrl, reviewsDir });
  const model = DEFAULT_ANALYSIS_MODEL;
  const analysisResult = await runReviewAnalysis({
    execute: resolveAnalysisExecutor({ model }),
    model,
    runDir,
  });

  return {
    analysisPath: analysisResult.analysisPath,
    diffPath: paths.diffPath,
    diffInventoryPath: paths.diffInventoryPath,
    diffSummaryPath: paths.diffSummaryPath,
    judgePath: analysisResult.judgePath,
    metadataPath: paths.metadataPath,
    runDir,
  };
}

export async function createBenchmarkRun({
  execute,
  model,
  onEvent,
  prUrl,
  provider,
  reasoningEffort,
  reviewsDir,
  runDir,
  signal,
  sourceRunDir = null,
}) {
  throwIfAborted(signal);
  const selectedModel =
    typeof model === "string" && model.trim() ? model.trim() : DEFAULT_ANALYSIS_MODEL;
  const selectedProvider = normalizeAnalysisProvider(
    provider || inferAnalysisProvider(selectedModel),
  );

  const parsed = parseGitHubPrUrl(prUrl);
  const resolvedReviewsDir = path.resolve(reviewsDir);
  const resolvedRunDir = path.resolve(
    runDir || path.join(resolvedReviewsDir, parsed.slug, createRunId()),
  );

  await mkdir(resolvedRunDir, { recursive: true });

  const input = sourceRunDir
    ? await runTimedStage({
        label: "Reuse frozen PR input",
        onEvent,
        signal,
        stageId: "input.reuse",
        task: async () => {
          const resolvedSourceRunDir = path.resolve(sourceRunDir);
          const [metadata, diff] = await Promise.all([
            readJson(path.join(resolvedSourceRunDir, "metadata.json")),
            readFile(path.join(resolvedSourceRunDir, "diff.patch"), "utf8"),
          ]);
          const sourceSlug = parseGitHubPrUrl(metadata.url || prUrl).slug;

          if (sourceSlug !== parsed.slug) {
            throw new Error(
              `Frozen source ${sourceSlug} does not match requested PR ${parsed.slug}.`,
            );
          }

          return { diff, metadata };
        },
      })
    : await runTimedStage({
        label: "Fetch PR from GitHub",
        onEvent,
        signal,
        stageId: "input.fetch",
        task: () =>
          fetchPullRequest(prUrl, {
            onEvent,
            parentStageId: "input.fetch",
            signal,
          }),
      });

  const { diffInventory, diffSummary } = await runTimedStage({
    getMetrics: (result) => ({
      changedLineCount: result.diffInventory.changedLineCount,
      fileCount: result.diffInventory.files.length,
    }),
    label: "Build diff inventory",
    onEvent,
    signal,
    stageId: "inventory",
    task: async () => {
      const inventory = await runTimedStage({
        getMetrics: (value) => ({
          changedLineCount: value.changedLineCount,
          fileCount: value.files.length,
        }),
        label: "Parse changed lines",
        onEvent,
        parentStageId: "inventory",
        signal,
        stageId: "inventory.parse",
        task: () => createDiffInventory(input.diff),
      });
      const summary = await runTimedStage({
        getMetrics: (value) => ({
          changedLineCount: value.changedLineCount,
          fileCount: value.files.length,
        }),
        label: "Build compact diff summary",
        onEvent,
        parentStageId: "inventory",
        signal,
        stageId: "inventory.summary",
        task: () => createDiffSummary(inventory),
      });

      return {
        diffInventory: inventory,
        diffSummary: summary,
      };
    },
  });
  const paths = buildRunPaths({ runDir: resolvedRunDir });

  await runTimedStage({
    label: "Persist frozen PR input",
    onEvent,
    signal,
    stageId: "input.persist",
    task: () =>
      Promise.all([
        writeFile(paths.diffInventoryPath, `${JSON.stringify(diffInventory, null, 2)}\n`, "utf8"),
        writeFile(paths.diffSummaryPath, `${JSON.stringify(diffSummary)}\n`, "utf8"),
        writeFile(paths.metadataPath, `${JSON.stringify(input.metadata, null, 2)}\n`, "utf8"),
        writeFile(paths.diffPath, input.diff, "utf8"),
      ]),
  });

  const analysisResult = await runReviewAnalysis({
    execute:
      execute || resolveAnalysisExecutor({ model: selectedModel, provider: selectedProvider }),
    model: selectedModel,
    onEvent,
    reasoningEffort,
    runDir: resolvedRunDir,
    signal,
  });

  return {
    analysisPath: analysisResult.analysisPath,
    diffPath: paths.diffPath,
    diffInventoryPath: paths.diffInventoryPath,
    diffSummary,
    diffSummaryPath: paths.diffSummaryPath,
    judgePath: analysisResult.judgePath,
    metadata: input.metadata,
    metadataPath: paths.metadataPath,
    runDir: resolvedRunDir,
    ...(analysisResult.usage ? { usage: analysisResult.usage } : {}),
  };
}

async function createPrInputRun({ prUrl, reviewsDir }) {
  const parsed = parseGitHubPrUrl(prUrl);
  const runDir = path.join(reviewsDir, parsed.slug, createRunId());

  await mkdir(runDir, { recursive: true });

  const { metadata, diff } = await fetchPullRequest(prUrl);
  const diffInventory = createDiffInventory(diff);
  const diffSummary = createDiffSummary(diffInventory);

  const paths = buildRunPaths({ runDir });

  await Promise.all([
    writeFile(paths.diffInventoryPath, `${JSON.stringify(diffInventory, null, 2)}\n`, "utf8"),
    writeFile(paths.diffSummaryPath, `${JSON.stringify(diffSummary)}\n`, "utf8"),
    writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    writeFile(paths.diffPath, diff, "utf8"),
  ]);

  return {
    diff,
    metadata,
    paths,
    runDir,
  };
}

function buildRunPaths({ runDir }) {
  return {
    diffPath: path.join(runDir, "diff.patch"),
    diffInventoryPath: path.join(runDir, "diff-inventory.json"),
    diffSummaryPath: path.join(runDir, "diff-summary.json"),
    metadataPath: path.join(runDir, "metadata.json"),
  };
}

function createRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runTimedStage({
  getMetrics = () => ({}),
  label,
  onEvent,
  parentStageId,
  signal,
  stageId,
  task,
}) {
  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();

  await emitRunEvent(onEvent, {
    at: startedAt.toISOString(),
    label,
    parentStageId,
    stageId,
    type: "stage-start",
  });

  try {
    throwIfAborted(signal);
    const result = await task();
    throwIfAborted(signal);
    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;

    await emitRunEvent(onEvent, {
      at: new Date().toISOString(),
      metrics: {
        ...getMetrics(result),
        elapsedMs,
      },
      parentStageId,
      stageId,
      status: "completed",
      type: "stage-finish",
    });
    return result;
  } catch (error) {
    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;

    await emitRunEvent(onEvent, {
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      metrics: { elapsedMs },
      parentStageId,
      stageId,
      status: isAbortError(error) ? "canceled" : "failed",
      type: "stage-finish",
    });
    throw error;
  }
}

async function emitRunEvent(onEvent, event) {
  if (onEvent) {
    await onEvent(event);
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
