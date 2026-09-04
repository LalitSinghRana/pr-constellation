import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ghText,
  parseGitHubPrUrl,
  parseReviewSlug,
} from "../../analysis-worker/workflow/02-fetch-pr/github.js";
import { trackedQueueItems } from "../inbox/inbox-service/queue-state.js";
import { reviewsDir } from "../runtime-config.js";

export async function loadReviewContext(
  slug,
  { fetchMetadata, loadInboxMetadata, reviewRoot = reviewsDir } = {},
) {
  if (typeof slug !== "string" || !/^[\w-]+$/.test(slug) || slug.length > 200) {
    throw new Error("A valid review slug is required.");
  }

  try {
    return await loadReviewContextFromRuns(slug, reviewRoot);
  } catch (error) {
    if (error.message !== "Review not found.") {
      throw error;
    }
  }

  let parsed;
  try {
    parsed = parseReviewSlug(slug);
  } catch {
    throw new Error("Review not found.");
  }
  const prUrl = `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
  const metadata = await resolvePresentation(parsed, prUrl, { fetchMetadata, loadInboxMetadata });
  const headSha = metadata.headRefOid || metadata.commits?.at(-1)?.oid || "";
  return {
    headSha,
    metadata,
    number: Number(parsed.number),
    owner: parsed.owner,
    prUrl: typeof metadata.url === "string" && metadata.url ? metadata.url : prUrl,
    repo: parsed.repo,
    runId: null,
    slug,
  };
}

async function resolvePresentation(parsed, prUrl, { fetchMetadata, loadInboxMetadata }) {
  try {
    return fetchMetadata ? await fetchMetadata(parsed) : await fetchPullRequestPresentation(prUrl);
  } catch (error) {
    const inboxMetadata = loadInboxMetadata
      ? await loadInboxMetadata(parsed)
      : await loadInboxPresentation(parsed);
    if (inboxMetadata) return inboxMetadata;
    throw error;
  }
}

async function loadInboxPresentation(parsed) {
  try {
    const { getInboxStore } = await import("../inbox/inbox-service.js");
    const store = await getInboxStore();
    const item = trackedQueueItems(store.readQueueState()).find((entry) => {
      try {
        return parseGitHubPrUrl(entry.url).slug === parsed.slug;
      } catch {
        return false;
      }
    });
    return item ? presentationFromInboxItem(item) : null;
  } catch {
    return null;
  }
}

function presentationFromInboxItem(item) {
  return {
    additions: item.additions ?? null,
    author: item.author ? { login: item.author } : {},
    body: "",
    changedFiles: item.changedFiles ?? null,
    createdAt: item.createdAt || "",
    deletions: item.deletions ?? null,
    headRefOid: item.headSha || "",
    isDraft: Boolean(item.draft),
    number: item.number,
    state: item.state || "",
    title: item.title || "",
    url: item.url || "",
  };
}

async function loadReviewContextFromRuns(slug, reviewRoot) {
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

export async function fetchPullRequestPresentation(prUrl, executeGh = ghText) {
  const text = await executeGh([
    "pr",
    "view",
    prUrl,
    "--json",
    [
      "additions",
      "author",
      "baseRefName",
      "body",
      "changedFiles",
      "createdAt",
      "deletions",
      "headRefName",
      "headRefOid",
      "isDraft",
      "number",
      "state",
      "title",
      "url",
    ].join(","),
  ]);
  return JSON.parse(text);
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
