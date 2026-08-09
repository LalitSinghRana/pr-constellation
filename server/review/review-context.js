import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseGitHubPrUrl } from "../../analysis-worker/workflow/02-fetch-pr/github.js";
import { reviewsDir } from "../runtime-config.js";

export async function loadReviewContext(slug, { reviewRoot = reviewsDir } = {}) {
  if (typeof slug !== "string" || !/^[\w-]+$/.test(slug) || slug.length > 200) {
    throw new Error("A valid review slug is required.");
  }

  const slugDir = path.join(reviewRoot, slug);
  const entries = await readdir(slugDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error("Review not found.");
    }
    throw error;
  });
  const runIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const runId of runIds) {
    const metadataPath = path.join(slugDir, runId, "metadata.json");
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      const prUrl = typeof metadata.url === "string" ? metadata.url : "";
      const parsed = parseGitHubPrUrl(prUrl);
      const headSha = metadata.headRefOid || metadata.commits?.at(-1)?.oid || "";
      if (!headSha) {
        throw new Error("Review metadata is missing headRefOid.");
      }
      return {
        headSha,
        metadata,
        number: Number(parsed.number),
        owner: parsed.owner,
        prUrl,
        repo: parsed.repo,
        runId,
        slug,
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      if (error.message === "Review metadata is missing headRefOid.") {
        throw error;
      }
    }
  }

  throw new Error("Review not found.");
}

export function resolveHeadSha(metadata) {
  return metadata?.headRefOid || metadata?.commits?.at(-1)?.oid || null;
}

export async function loadReviewDiff(slug, runId) {
  if (typeof slug !== "string" || !slug) {
    throw new Error("A valid review slug is required.");
  }
  if (typeof runId !== "string" || !runId) {
    throw new Error("A valid review run ID is required.");
  }

  return readFile(path.join(reviewsDir, slug, runId, "diff.patch"), "utf8");
}
