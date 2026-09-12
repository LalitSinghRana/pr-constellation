import { parseGitHubPrUrl } from "../../../analysis-worker/workflow/02-fetch-pr/github.js";
import { applyInboxActivity, getPrActivity } from "./activity.js";
import { prKey } from "./identity.js";
import { inboxFromQueue } from "./pr-items.js";
import { pinQueueItem } from "./queue-state.js";

export async function addPinnedInboxPullRequest(
  url,
  {
    getActivity = getPrActivity,
    mutateQueueState,
    now = new Date(),
    subscribeToIssue,
    teammates = [],
    teams = [],
    username = "",
  } = {},
) {
  let parsed;
  try {
    parsed = parseGitHubPrUrl(typeof url === "string" ? url.trim() : "");
  } catch {
    const error = new Error("A GitHub pull request URL is required.");
    error.status = 400;
    throw error;
  }
  const seed = {
    number: Number(parsed.number),
    repository: `${parsed.owner}/${parsed.repo}`,
    title: `Pull request #${parsed.number}`,
    updatedAt: now.toISOString(),
    url: `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`,
  };
  let activity;
  try {
    activity = await getActivity(seed);
  } catch (cause) {
    const error = new Error("That pull request could not be loaded from GitHub.");
    error.cause = cause;
    error.status = 502;
    throw error;
  }
  const items = new Map();
  const item = applyInboxActivity(items, seed, activity, { teammates, teams, username });
  item.id = item.id || prKey(seed);
  let warning;
  try {
    await subscribeToIssue?.({
      number: Number(parsed.number),
      owner: parsed.owner,
      repo: parsed.repo,
    });
  } catch {
    warning = "Added locally, but GitHub could not subscribe you to this pull request.";
  }
  const result = await mutateQueueState(
    (state) => {
      const pin = pinQueueItem(state, item, now.toISOString());
      if (!pin) return null;
      const ranked = inboxFromQueue(state, username).items.find((entry) => entry.id === item.id);
      return ranked ? { ...ranked, pinned: true } : null;
    },
    {
      ids: [item.id],
    },
  );
  if (!result) {
    const error = new Error("That pull request could not be added to the inbox.");
    error.status = 400;
    throw error;
  }
  return {
    ...result,
    slug: result.slug || parsed.slug,
    ...(warning ? { warning } : {}),
  };
}
