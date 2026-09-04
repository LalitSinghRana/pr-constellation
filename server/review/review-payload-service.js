import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertStorageId } from "../analysis/run-store.js";
import { loadReviewContext } from "./review-context.js";

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

export async function getReviewContext(store, slug) {
  assertStorageId(slug, "slug");
  let context;
  try {
    context = await loadReviewContext(slug, { reviewRoot: store.reviewsDir });
  } catch (error) {
    throw createReviewNotFoundError(error.message || "Review not found.", { cause: error });
  }
  return {
    analysis: await analysisStatusForSlug(store, slug),
    review: reviewFromMetadata(context.metadata, context),
    slug,
  };
}

async function analysisStatusForSlug(store, slug) {
  const href = `/reviews/${encodeURIComponent(slug)}/`;
  const runs = (await store.scanRuns()).filter((run) => run.slug === slug);
  const succeeded = runs.find((run) => run.status === "succeeded");
  if (succeeded) {
    return { href, runId: succeeded.runId, status: "succeeded" };
  }
  const active = runs.find((run) => run.status === "queued" || run.status === "running");
  if (active) {
    return { href, runId: active.runId, status: active.status };
  }
  if (runs[0]) {
    return { href, runId: runs[0].runId, status: runs[0].status };
  }
  return { href, runId: null, status: "not_started" };
}

function reviewFromMetadata(metadata, context) {
  return {
    additions: metadata.additions ?? null,
    authorAvatarUrl: metadata.author?.avatarUrl || "",
    authorLogin: metadata.author?.login || "",
    baseRefName: metadata.baseRefName || "",
    body: metadata.body || "",
    changedFiles: metadata.changedFiles ?? null,
    createdAt: metadata.createdAt || "",
    deletions: metadata.deletions ?? null,
    headRefName: metadata.headRefName || "",
    isDraft: Boolean(metadata.isDraft),
    number: context.number,
    state: metadata.state || "",
    title: metadata.title || "",
    url: context.prUrl,
  };
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
