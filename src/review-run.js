import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchPullRequest, parseGitHubPrUrl } from "./github.js";
import { renderDiffHtml } from "./render.js";

export async function createReviewRun({ prUrl, reviewsDir }) {
  const parsed = parseGitHubPrUrl(prUrl);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(reviewsDir, parsed.slug, timestamp);

  await mkdir(runDir, { recursive: true });

  const { metadata, diff } = await fetchPullRequest(prUrl);
  const html = await renderDiffHtml({ pr: metadata, diff });

  const metadataPath = path.join(runDir, "metadata.json");
  const diffPath = path.join(runDir, "diff.patch");
  const htmlPath = path.join(runDir, "index.html");

  await Promise.all([
    writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    writeFile(diffPath, diff, "utf8"),
    writeFile(htmlPath, html, "utf8"),
  ]);

  return {
    diffPath,
    htmlPath,
    metadataPath,
    runDir,
  };
}
