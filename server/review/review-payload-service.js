import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertStorageId } from "../analysis/run-store.js";

export async function getLatestReviewPayload(store, slug) {
  assertStorageId(slug, "slug");
  const manifest = await store.getLatestSucceededReviewRun(slug);
  if (!manifest) {
    throw createReviewNotFoundError(`No succeeded analysis found for review "${slug}".`);
  }
  return readReviewPayload(store, slug, manifest.runId);
}

export async function getReviewPayloadForRun(store, slug, runId) {
  assertStorageId(slug, "slug");
  assertStorageId(runId, "runId");
  return readReviewPayload(store, slug, runId);
}

async function readReviewPayload(store, slug, runId) {
  const runDir = store.getRunDir(slug, runId);
  const reviewsRealPath = await realpath(store.reviewsDir);
  let runRealPath;
  try {
    runRealPath = await realpath(runDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw createReviewNotFoundError(`Review run "${slug}/${runId}" was not found.`);
    }
    throw error;
  }

  if (runRealPath !== reviewsRealPath && !runRealPath.startsWith(`${reviewsRealPath}${path.sep}`)) {
    throw createReviewNotFoundError(`Review run "${slug}/${runId}" was not found.`);
  }

  const analysisPath = path.join(runDir, "analysis.json");
  const metadataPath = path.join(runDir, "metadata.json");
  const diffPath = path.join(runDir, "diff.patch");
  const diffInventoryPath = path.join(runDir, "diff-inventory.json");

  let analysisRaw;
  let metadataRaw;
  let diff;
  let diffInventoryRaw;
  try {
    [analysisRaw, metadataRaw, diff, diffInventoryRaw] = await Promise.all([
      readContainedFile(reviewsRealPath, analysisPath),
      readContainedFile(reviewsRealPath, metadataPath),
      readContainedFile(reviewsRealPath, diffPath, "utf8"),
      readContainedFile(reviewsRealPath, diffInventoryPath),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "REVIEW_NOT_FOUND") {
      throw createReviewNotFoundError(
        `Review run "${slug}/${runId}" is missing analysis artifacts.`,
      );
    }
    throw error;
  }

  let analysis;
  let metadata;
  let diffInventory;
  try {
    analysis = JSON.parse(analysisRaw);
    metadata = JSON.parse(metadataRaw);
    diffInventory = JSON.parse(diffInventoryRaw);
  } catch (error) {
    throw createReviewNotFoundError(
      `Review run "${slug}/${runId}" has unreadable analysis artifacts.`,
      { cause: error },
    );
  }

  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    throw createReviewNotFoundError(`Review run "${slug}/${runId}" has invalid analysis.json.`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw createReviewNotFoundError(`Review run "${slug}/${runId}" has invalid metadata.json.`);
  }
  if (!diffInventory || typeof diffInventory !== "object" || Array.isArray(diffInventory)) {
    throw createReviewNotFoundError(
      `Review run "${slug}/${runId}" has invalid diff-inventory.json.`,
    );
  }
  if (typeof diff !== "string") {
    throw createReviewNotFoundError(`Review run "${slug}/${runId}" has invalid diff.patch.`);
  }

  return {
    analysis,
    diff,
    diffInventory,
    metadata,
    runId,
    slug,
  };
}

async function readContainedFile(reviewsRealPath, filePath, encoding = "utf8") {
  const stats = await stat(filePath);
  if (!stats.isFile()) {
    const error = new Error("Review artifact is not a file.");
    error.code = "ENOENT";
    throw error;
  }
  const realFile = await realpath(filePath);
  if (realFile !== reviewsRealPath && !realFile.startsWith(`${reviewsRealPath}${path.sep}`)) {
    const error = new Error("Review artifact escaped reviews directory.");
    error.code = "REVIEW_NOT_FOUND";
    throw error;
  }
  return readFile(realFile, encoding);
}

function createReviewNotFoundError(message, options) {
  const error = new Error(message, options);
  error.code = "REVIEW_NOT_FOUND";
  return error;
}
