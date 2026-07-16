import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCodexGraphAnalysis } from "./analysis/codex-agent.js";
import { fetchPullRequest, parseGitHubPrUrl } from "./github.js";
import { renderDiffHtml } from "./render.js";

export async function createReviewRun({ prUrl, reviewsDir }) {
  const { diff, metadata, paths, runDir } = await createPrInputRun({ prUrl, reviewsDir });
  const html = await renderDiffHtml({ pr: metadata, diff });

  await writeFile(paths.htmlPath, html, "utf8");

  return {
    diffPath: paths.diffPath,
    htmlPath: paths.htmlPath,
    metadataPath: paths.metadataPath,
    runDir,
  };
}

export async function createAnalysisRun({ prUrl, reviewsDir }) {
  const { paths, runDir } = await createPrInputRun({ prUrl, reviewsDir });
  const analysisResult = await runCodexGraphAnalysis({ runDir });

  return {
    analysisPath: analysisResult.analysisPath,
    diffPath: paths.diffPath,
    metadataPath: paths.metadataPath,
    runDir,
  };
}

export async function renderExistingRun({ runDir }) {
  const metadataPath = path.join(runDir, "metadata.json");
  const diffPath = path.join(runDir, "diff.patch");
  const analysisPath = path.join(runDir, "analysis.json");
  const htmlPath = path.join(runDir, "index.html");

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

  await writeFile(htmlPath, html, "utf8");

  return {
    analysisPath: analysis ? analysisPath : null,
    diffPath,
    htmlPath,
    metadataPath,
    runDir,
  };
}

async function createPrInputRun({ prUrl, reviewsDir }) {
  const parsed = parseGitHubPrUrl(prUrl);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(reviewsDir, parsed.slug, timestamp);

  await mkdir(runDir, { recursive: true });

  const { metadata, diff } = await fetchPullRequest(prUrl);

  const metadataPath = path.join(runDir, "metadata.json");
  const diffPath = path.join(runDir, "diff.patch");
  const htmlPath = path.join(runDir, "index.html");

  await Promise.all([
    writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    writeFile(diffPath, diff, "utf8"),
  ]);

  return {
    diff,
    metadata,
    paths: {
      diffPath,
      htmlPath,
      metadataPath,
    },
    runDir,
  };
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
