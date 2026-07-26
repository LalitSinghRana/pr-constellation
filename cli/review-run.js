import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDiffInventory, createDiffSummary } from "../workflows/pr-graph-analysis/03-build-diff-inventory/diff-inventory.js";
import { runCodexGraphAnalysis } from "../workflows/pr-graph-analysis/07-run-retry-loop/codex-agent.js";
import { fetchPullRequest, parseGitHubPrUrl } from "../workflows/pr-graph-analysis/02-fetch-pr/github.js";
import { renderDiffHtml } from "../src/render.js";

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
  const analysisResult = await runCodexGraphAnalysis({ runDir });

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
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(reviewsDir, parsed.slug, timestamp);

  await mkdir(runDir, { recursive: true });

  const { metadata, diff } = await fetchPullRequest(prUrl);
  const diffInventory = createDiffInventory(diff);
  const diffSummary = createDiffSummary(diffInventory);

  const metadataPath = path.join(runDir, "metadata.json");
  const diffPath = path.join(runDir, "diff.patch");
  const diffInventoryPath = path.join(runDir, "diff-inventory.json");
  const diffSummaryPath = path.join(runDir, "diff-summary.json");
  const htmlPath = path.join(runDir, "index.html");
  const stableHtmlPath = path.join(reviewsDir, parsed.slug, "index.html");

  await Promise.all([
    writeFile(diffInventoryPath, `${JSON.stringify(diffInventory, null, 2)}\n`, "utf8"),
    writeFile(diffSummaryPath, `${JSON.stringify(diffSummary)}\n`, "utf8"),
    writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    writeFile(diffPath, diff, "utf8"),
  ]);

  return {
    diff,
    metadata,
    paths: {
      diffPath,
      diffInventoryPath,
      diffSummaryPath,
      htmlPath,
      metadataPath,
      stableHtmlPath,
    },
    runDir,
  };
}

async function writeReviewHtml({ html, htmlPath, stableHtmlPath }) {
  await Promise.all([
    writeFile(htmlPath, html, "utf8"),
    writeFile(stableHtmlPath, html, "utf8"),
  ]);
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
