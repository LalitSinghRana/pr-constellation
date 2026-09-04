import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prKey, repositoryName } from "./identity.js";
import { seedNotificationPullRequests } from "./notification-map.js";
import { addSignal, addSource } from "./pr-items.js";
import { notificationTimesFromPullRequests, pullRequestRefreshIds } from "./pull-request-change.js";

const exec = promisify(execFile);

const activityQuery = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        additions
        changedFiles
        deletions
        headRefOid
        title
        url
        state
        reviewDecision
        createdAt
        updatedAt
        mergedAt
        closedAt
        isDraft
        author { login }
        labels(first: 4) { nodes { name color } }
        commits(last: 1) { nodes { commit { committedDate } } }
        comments(last: 100) {
          totalCount
          nodes { author { login } createdAt url }
        }
        reviews(last: 100) {
          nodes { author { login } state submittedAt url }
        }
        reviewThreads(first: 100) {
          nodes {
            isResolved
            isOutdated
            comments(first: 100) {
              nodes { author { login } createdAt url }
            }
          }
        }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              ... on User { login }
              ... on Team { combinedSlug }
            }
          }
        }
      }
    }
  }
`;

const graphQlSignalKinds = new Set([
  "direct-review",
  "team-review",
  "teammate-pr",
  "post-merge-comment",
  "review-reply",
  "new-commits",
  "new-comments",
  "team-covered",
  "my-pr-activity",
]);

export async function ghJson(args, timeout = 45_000) {
  const { stdout } = await exec("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout,
  });
  return JSON.parse(stdout);
}

export async function mapLimited(values, limit, callback) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await callback(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

export function summarizeActivity(activity, username, teammates = []) {
  const normalizedUser = username.toLowerCase();
  const teammateSet = new Set(teammates.map((person) => person.toLowerCase()));
  const reviews = activity.reviews?.nodes ?? [];
  const myReviews = reviews.filter(
    (review) => review.author?.login?.toLowerCase() === normalizedUser,
  );
  const latestReview = myReviews.at(-1) ?? null;
  const latestReviewAt = latestReview?.submittedAt ?? null;
  let newestReply = null;

  for (const thread of activity.reviewThreads?.nodes ?? []) {
    const comments = thread.comments?.nodes ?? [];
    const latestMine = [...comments]
      .reverse()
      .find((comment) => comment.author?.login?.toLowerCase() === normalizedUser);
    const latest = comments.at(-1);
    if (
      latestMine &&
      latest?.author?.login?.toLowerCase() !== normalizedUser &&
      new Date(latest.createdAt) > new Date(latestMine.createdAt) &&
      (!latestReviewAt || new Date(latest.createdAt) > new Date(latestReviewAt)) &&
      (!newestReply || new Date(latest.createdAt) > new Date(newestReply.createdAt))
    ) {
      newestReply = latest;
    }
  }

  const lastCommitAt = activity.commits?.nodes?.at(-1)?.commit?.committedDate ?? null;
  const newComment = latestReviewAt
    ? [...(activity.comments?.nodes ?? [])]
        .reverse()
        .find(
          (comment) =>
            comment.author?.login?.toLowerCase() !== normalizedUser &&
            new Date(comment.createdAt) > new Date(latestReviewAt),
        )
    : null;
  const coveringReview = reviews.find(
    (review) =>
      teammateSet.has(review.author?.login?.toLowerCase()) &&
      !["DISMISSED", "PENDING"].includes(review.state),
  );
  const postMergeComment = activity.mergedAt
    ? ([
        ...(activity.comments?.nodes ?? []),
        ...(activity.reviewThreads?.nodes ?? []).flatMap((thread) => thread.comments?.nodes ?? []),
      ]
        .filter(
          (comment) =>
            comment.author?.login?.toLowerCase() !== normalizedUser &&
            new Date(comment.createdAt) > new Date(activity.mergedAt),
        )
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ?? null)
    : null;

  return {
    latestReviewState: latestReview?.state ?? null,
    latestReviewAt,
    newestReply,
    newComment,
    postMergeComment,
    hasNewCommits:
      Boolean(latestReviewAt && lastCommitAt) && new Date(lastCommitAt) > new Date(latestReviewAt),
    coveringTeammate: coveringReview?.author?.login ?? "",
  };
}

export function activityCandidates(items, pullRequestNotifications, limit = 60) {
  const notificationTimes = notificationTimesFromPullRequests(pullRequestNotifications);

  const candidates = [...items.values()].map((item) => {
    const updatedAt = Date.parse(item.updatedAt ?? "");
    const notificationAt = notificationTimes.get(item.id) ?? 0;
    const seenNotificationAt = Date.parse(item.notificationUpdatedAt ?? "") || 0;
    return {
      item,
      changed: notificationAt > seenNotificationAt,
      priority: Math.max(Number.isFinite(updatedAt) ? updatedAt : 0, notificationAt),
    };
  });
  candidates.sort(
    (left, right) => Number(right.changed) - Number(left.changed) || right.priority - left.priority,
  );

  const changedCount = candidates.filter(({ changed }) => changed).length;
  return candidates.slice(0, Math.max(limit, changedCount)).map(({ item }) => item);
}

export function activityRefreshTargets(
  items,
  pullRequestNotifications,
  { authoredOpenIds = null, authoredPullRequests = [], inboxIds = null, queueRecords = {} } = {},
) {
  const refreshIds = pullRequestRefreshIds({
    authoredOpenIds,
    authoredPullRequests,
    inboxIds,
    items,
    pullRequestNotifications,
    queueRecords,
  });
  const notificationTimes = notificationTimesFromPullRequests(pullRequestNotifications);
  return [...items.values()]
    .filter((item) => refreshIds.has(item.id))
    .sort((left, right) => {
      const leftPriority = Math.max(
        Date.parse(left.updatedAt ?? "") || 0,
        notificationTimes.get(left.id) ?? 0,
      );
      const rightPriority = Math.max(
        Date.parse(right.updatedAt ?? "") || 0,
        notificationTimes.get(right.id) ?? 0,
      );
      return rightPriority - leftPriority;
    });
}

export function reviewRequestSignals(activity, username, teams = []) {
  const normalizedUser = username.toLowerCase();
  const teamSet = new Set(teams.map((team) => team.toLowerCase()));
  const signals = [];
  for (const node of activity.reviewRequests?.nodes ?? []) {
    const reviewer = node?.requestedReviewer;
    if (!reviewer) continue;
    const login = typeof reviewer.login === "string" ? reviewer.login : "";
    const slug = typeof reviewer.combinedSlug === "string" ? reviewer.combinedSlug : "";
    if (login && login.toLowerCase() === normalizedUser) {
      signals.push({ kind: "direct-review", detail: "" });
    } else if (slug && teamSet.has(slug.toLowerCase())) {
      signals.push({ kind: "team-review", detail: slug });
    }
  }
  return signals;
}

export function prFromActivity(item, activity) {
  const reviewCommentCount = (activity.reviewThreads?.nodes ?? []).reduce(
    (total, thread) => total + (thread.comments?.nodes?.length ?? 0),
    0,
  );
  return {
    number: item.number,
    title: activity.title,
    url: activity.url,
    repository: { nameWithOwner: item.repository },
    author: { login: activity.author?.login ?? "" },
    state: activity.state,
    reviewDecision: activity.reviewDecision,
    commentsCount: (activity.comments?.totalCount ?? 0) + reviewCommentCount,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
    mergedAt: activity.mergedAt,
    closedAt: activity.closedAt,
    isDraft: activity.isDraft,
    additions: activity.additions,
    deletions: activity.deletions,
    changedFiles: activity.changedFiles,
    headSha: activity.headRefOid,
    labels: activity.labels?.nodes ?? [],
  };
}

export function applyInboxActivity(
  items,
  item,
  activity,
  { username = "", teammates = [], teams = [] } = {},
) {
  const pr = prFromActivity(item, activity);
  addSource(items, pr, "activity");
  const current = items.get(prKey(pr));
  current.signals = (Array.isArray(current.signals) ? current.signals : []).filter(
    (signal) => !graphQlSignalKinds.has(signal.kind),
  );
  const authorLogin = activity.author?.login ?? "";
  if (authorLogin) {
    current.authored = Boolean(username && authorLogin.toLowerCase() === username.toLowerCase());
  }
  const summary = summarizeActivity(activity, username, teammates);
  current.latestReviewState = summary.latestReviewState;
  current.reviewed = Boolean(summary.latestReviewState);
  items.set(current.id, current);

  if (
    authorLogin &&
    teammates.some((person) => person.toLowerCase() === authorLogin.toLowerCase()) &&
    authorLogin.toLowerCase() !== username.toLowerCase()
  ) {
    addSignal(items, pr, "teammate-pr", authorLogin);
  }

  for (const signal of reviewRequestSignals(activity, username, teams)) {
    addSignal(items, pr, signal.kind, signal.detail);
  }

  if (summary.postMergeComment) {
    addSignal(
      items,
      pr,
      "post-merge-comment",
      summary.postMergeComment.author?.login ?? "",
      summary.postMergeComment.url ?? pr.url,
    );
  } else if (summary.newestReply) {
    addSignal(
      items,
      pr,
      "review-reply",
      summary.newestReply.author?.login ?? "",
      summary.newestReply.url ?? pr.url,
    );
  }
  if (summary.hasNewCommits && pr.state !== "MERGED") {
    addSignal(items, pr, "new-commits");
  }

  const afterComments = items.get(prKey(pr));
  if (
    summary.newComment &&
    !summary.postMergeComment &&
    !afterComments.signals.some((signal) =>
      ["review-reply", "direct-mention"].includes(signal.kind),
    )
  ) {
    addSignal(
      items,
      pr,
      "new-comments",
      summary.newComment.author?.login ?? "",
      summary.newComment.url ?? pr.url,
    );
  }

  const enriched = items.get(prKey(pr));
  if (
    summary.coveringTeammate &&
    enriched.signals.some((signal) => signal.kind === "team-review") &&
    !enriched.signals.some((signal) => signal.kind === "teammate-pr")
  ) {
    addSignal(items, pr, "team-covered", summary.coveringTeammate);
  }

  return items.get(prKey(pr));
}

export async function getPrActivity(pr) {
  const [owner, name] = repositoryName(pr).split("/");
  const result = await ghJson([
    "api",
    "graphql",
    "-f",
    `query=${activityQuery}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${pr.number}`,
  ]);
  const activity = result.data?.repository?.pullRequest;
  if (!activity) throw new Error("Pull request activity unavailable");
  return activity;
}

export async function refreshNotificationItems(
  items,
  pullRequestNotifications,
  touched,
  {
    authoredOpenIds = null,
    authoredPullRequests = [],
    getActivity = getPrActivity,
    inboxIds = null,
    queueRecords = {},
    username = "",
    teammates = [],
    teams = [],
  } = {},
) {
  const before = new Set(items.keys());
  const notificationTimes = notificationTimesFromPullRequests(pullRequestNotifications);
  for (const { pr } of pullRequestNotifications) {
    const id = prKey(pr);
    if (items.has(id)) touched.add(id);
  }
  seedNotificationPullRequests(items, pullRequestNotifications);
  for (const id of items.keys()) {
    if (!before.has(id)) touched.add(id);
  }

  const candidates = activityRefreshTargets(items, pullRequestNotifications, {
    authoredOpenIds,
    authoredPullRequests,
    inboxIds,
    queueRecords,
  });
  const warnings = [];
  const inspected = await mapLimited(candidates, 5, async (candidate) => {
    try {
      return { item: candidate, activity: await getActivity(candidate) };
    } catch {
      return { failed: true };
    }
  });
  for (const result of inspected) {
    if (result.failed) {
      warnings.push("Some pull requests could not be refreshed.");
      continue;
    }
    const enriched = applyInboxActivity(items, result.item, result.activity, {
      username,
      teammates,
      teams,
    });
    const id = enriched.id;
    const notificationAt = notificationTimes.get(id);
    if (notificationAt) {
      items.get(id).notificationUpdatedAt = new Date(notificationAt).toISOString();
    }
    touched.add(id);
  }
  return warnings;
}
