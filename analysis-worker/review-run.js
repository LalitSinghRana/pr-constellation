import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderDiffHtml } from "../client/src/review/render.js";
import { fetchPullRequest, parseGitHubPrUrl } from "./workflow/02-fetch-pr/github.js";
import {
  createDiffInventory,
  createDiffSummary,
} from "./workflow/03-build-diff-inventory/diff-inventory.js";
import { runClaudeExec } from "./workflow/07-run-retry-loop/claude-agent.js";
import { runCodexReviewAnalysis } from "./workflow/07-run-retry-loop/codex-agent.js";
import { isAbortError, throwIfAborted } from "./workflow/abort.js";

export async function createReviewRun({ prUrl, reviewsDir }) {
  const { diff, metadata, paths, runDir } = await createPrInputRun({ prUrl, reviewsDir });
  const html = await renderDiffHtml({ pr: metadata, diff });

  await writeReviewHtml({
    html,
    htmlPath: paths.htmlPath,
    stableHtmlPath: paths.stableHtmlPath,
  });

  return {
    diffPath: paths.diffPath,
    diffInventoryPath: paths.diffInventoryPath,
    diffSummaryPath: paths.diffSummaryPath,
    htmlPath: paths.htmlPath,
    metadataPath: paths.metadataPath,
    runDir,
    stableHtmlPath: paths.stableHtmlPath,
  };
}

export async function createAnalysisRun({ prUrl, reviewsDir }) {
  const { paths, runDir } = await createPrInputRun({ prUrl, reviewsDir });
  const analysisResult = await runCodexReviewAnalysis({ runDir });

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
  executeClaude = runClaudeExec,
  executeCodex,
  model,
  onEvent,
  prUrl,
  provider = "codex",
  reasoningEffort,
  reviewsDir,
  runDir,
  signal,
  sourceRunDir = null,
}) {
  throwIfAborted(signal);
  const selectedProvider = normalizeAnalysisProvider(provider);

  const parsed = parseGitHubPrUrl(prUrl);
  const resolvedReviewsDir = path.resolve(reviewsDir);
  const resolvedRunDir = path.resolve(
    runDir || path.join(resolvedReviewsDir, parsed.slug, createRunId()),
  );
  const stableHtmlPath = path.join(resolvedReviewsDir, parsed.slug, "index.html");

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
  const paths = buildRunPaths({
    runDir: resolvedRunDir,
    stableHtmlPath,
  });

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

  const executeAnalysis =
    executeCodex || (selectedProvider === "claude" ? executeClaude : undefined);
  const analysisResult = await runCodexReviewAnalysis({
    ...(executeAnalysis ? { executeCodex: executeAnalysis } : {}),
    model,
    onEvent,
    reasoningEffort,
    runDir: resolvedRunDir,
    signal,
  });

  try {
    await runTimedStage({
      getMetrics: (documentHtml) => ({
        outputBytes: Buffer.byteLength(documentHtml),
      }),
      label: "Render review tree",
      onEvent,
      signal,
      stageId: "render",
      task: async () => {
        const documentHtml = await runTimedStage({
          getMetrics: (value) => ({
            outputBytes: Buffer.byteLength(value),
          }),
          label: "Build review document",
          onEvent,
          parentStageId: "render",
          signal,
          stageId: "render.build",
          task: () =>
            renderDiffHtml({
              analysis: analysisResult.analysis,
              diff: input.diff,
              pr: input.metadata,
            }),
        });

        await runTimedStage({
          label: "Persist review page",
          onEvent,
          parentStageId: "render",
          stageId: "render.persist",
          task: () =>
            writeRunReviewHtml({
              html: documentHtml,
              htmlPath: paths.htmlPath,
            }),
        });

        return documentHtml;
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && analysisResult.usage) {
      error.usage = { ...analysisResult.usage };
    }
    throw error;
  }

  return {
    analysisPath: analysisResult.analysisPath,
    diffPath: paths.diffPath,
    diffInventoryPath: paths.diffInventoryPath,
    diffSummary,
    diffSummaryPath: paths.diffSummaryPath,
    htmlPath: paths.htmlPath,
    judgePath: analysisResult.judgePath,
    metadata: input.metadata,
    metadataPath: paths.metadataPath,
    runDir: resolvedRunDir,
    stableHtmlPath,
    ...(analysisResult.usage ? { usage: analysisResult.usage } : {}),
  };
}

function normalizeAnalysisProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (provider === "codex" || provider === "claude") {
    return provider;
  }
  throw new TypeError(`Unsupported analysis provider "${value}".`);
}

export async function renderExistingRun({ runDir }) {
  const metadataPath = path.join(runDir, "metadata.json");
  const diffPath = path.join(runDir, "diff.patch");
  const analysisPath = path.join(runDir, "analysis.json");
  const htmlPath = path.join(runDir, "index.html");
  const stableHtmlPath = path.join(path.dirname(runDir), "index.html");

  const [metadata, diff, analysis] = await Promise.all([
    readJson(metadataPath),
    readFile(diffPath, "utf8"),
    readOptionalJson(analysisPath),
  ]);

  const html = await renderDiffHtml({
    analysis,
    diff,
    pr: metadata,
  });

  await writeReviewHtml({ html, htmlPath, stableHtmlPath });

  return {
    analysisPath: analysis ? analysisPath : null,
    diffPath,
    htmlPath,
    metadataPath,
    runDir,
    stableHtmlPath,
  };
}

async function createPrInputRun({ prUrl, reviewsDir }) {
  const parsed = parseGitHubPrUrl(prUrl);
  const runDir = path.join(reviewsDir, parsed.slug, createRunId());

  await mkdir(runDir, { recursive: true });

  const { metadata, diff } = await fetchPullRequest(prUrl);
  const diffInventory = createDiffInventory(diff);
  const diffSummary = createDiffSummary(diffInventory);

  const stableHtmlPath = path.join(reviewsDir, parsed.slug, "index.html");
  const paths = buildRunPaths({ runDir, stableHtmlPath });

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

function buildRunPaths({ runDir, stableHtmlPath }) {
  return {
    diffPath: path.join(runDir, "diff.patch"),
    diffInventoryPath: path.join(runDir, "diff-inventory.json"),
    diffSummaryPath: path.join(runDir, "diff-summary.json"),
    htmlPath: path.join(runDir, "index.html"),
    metadataPath: path.join(runDir, "metadata.json"),
    stableHtmlPath,
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

async function writeReviewHtml({ html, htmlPath, stableHtmlPath }) {
  await writeRunReviewHtml({ html, htmlPath });
  await publishStableReview({ htmlPath, stableHtmlPath });
}

async function writeRunReviewHtml({ html, htmlPath }) {
  await mkdir(path.dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, html, "utf8");
}

export async function publishStableReview({ htmlPath, stableHtmlPath }) {
  const resolvedHtmlPath = path.resolve(htmlPath);
  const resolvedStableHtmlPath = path.resolve(stableHtmlPath);

  if (resolvedHtmlPath === resolvedStableHtmlPath) {
    throw new Error("Run-specific and stable review paths must be different.");
  }

  const stableDirectory = path.dirname(resolvedStableHtmlPath);
  const temporaryStablePath = path.join(
    stableDirectory,
    `.${path.basename(resolvedStableHtmlPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(stableDirectory, { recursive: true });

  try {
    await copyFile(resolvedHtmlPath, temporaryStablePath);
    await rename(temporaryStablePath, resolvedStableHtmlPath);
  } catch (error) {
    await rm(temporaryStablePath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
