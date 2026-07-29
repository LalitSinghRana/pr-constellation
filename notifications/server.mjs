import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const port = Number.parseInt(process.env.PORT ?? "4174", 10);
const host = "127.0.0.1";
const settingsPath = join(homedir(), ".config", "pr-review-cockpit", "settings.json");
const searchFields =
  "author,commentsCount,createdAt,id,isDraft,labels,number,repository,state,title,updatedAt,url";

export const weights = Object.freeze({
  "direct-review": 10,
  "post-merge-comment": 10,
  "teammate-pr": 7,
  "review-reply": 6,
  "direct-mention": 6,
  "my-pr-activity": 5,
  "new-commits": 3,
  "team-review": 3,
  "new-comments": 2,
  "team-mention": 2,
  "team-covered": -4,
});

export const lifecycleScores = Object.freeze({
  reviewed: 10,
  new: 0,
  approved: -5,
  merged: -5,
  draft: -10,
  mine: 0,
  other: 0,
});

const lifecycleLabels = Object.freeze({
  reviewed: "Reviewed",
  new: "New / unreviewed",
  approved: "Approved",
  merged: "Merged",
  draft: "Draft",
  mine: "My PR",
  other: "Other notification PR",
});

const signalLabels = Object.freeze({
  "direct-review": "Direct review request",
  "post-merge-comment": "Comment after merge",
  "teammate-pr": "Teammate PR",
  "review-reply": "Reply to your review",
  "direct-mention": "Mentioned you",
  "my-pr-activity": "Activity on your PR",
  "new-commits": "New commits",
  "team-review": "Team review request",
  "new-comments": "New comments",
  "team-mention": "Team mentioned",
  "team-covered": "Covered by teammate",
});

const usernamePattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const teamPattern =
  /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i;

const activityQuery = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        title
        url
        state
        createdAt
        updatedAt
        mergedAt
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
      }
    }
  }
`;

async function ghJson(args) {
  const { stdout } = await exec("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 45_000,
  });
  return JSON.parse(stdout);
}

let detectedUser;
async function getDetectedUser() {
  detectedUser ??= ghJson(["api", "user"]).then((user) => user.login);
  return detectedUser;
}

function parseList(value, pattern, limit) {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [
    ...new Set(parts.map((part) => String(part).trim()).filter(Boolean)),
  ]
    .filter((part) => pattern.test(part))
    .slice(0, limit);
}

export function normalizeSettings(value = {}) {
  const username = typeof value.username === "string" ? value.username.trim() : "";
  return {
    username: usernamePattern.test(username) ? username : "",
    people: parseList(value.people, usernamePattern, 20),
    teams: parseList(value.teams, teamPattern, 10),
  };
}

async function readSettings() {
  try {
    return normalizeSettings(JSON.parse(await readFile(settingsPath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalizeSettings();
    throw error;
  }
}

async function saveSettings(value) {
  const settings = normalizeSettings(value);
  const temporaryPath = `${settingsPath}.tmp`;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, settingsPath);
  return settings;
}

async function searchPrs(args) {
  return ghJson([
    "search",
    "prs",
    ...args,
    "--state",
    "open",
    "--sort",
    "updated",
    "--order",
    "desc",
    "--limit",
    "100",
    "--json",
    searchFields,
  ]);
}

function repositoryName(pr) {
  return typeof pr.repository === "string" ? pr.repository : pr.repository.nameWithOwner;
}

function prKey(pr) {
  return `${repositoryName(pr)}#${pr.number}`;
}

function normalizePr(pr) {
  return {
    id: prKey(pr),
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repository: repositoryName(pr),
    author: pr.author?.login ?? "",
    state: pr.state ?? "OPEN",
    comments: pr.commentsCount ?? 0,
    createdAt: pr.createdAt ?? pr.updatedAt,
    updatedAt: pr.updatedAt,
    draft: pr.isDraft ?? false,
    labels: (pr.labels ?? []).slice(0, 4).map((label) => ({
      name: label.name,
      color: label.color,
    })),
    signals: [],
    notification: null,
    authored: false,
    reviewed: false,
    latestReviewState: null,
  };
}

function mergePr(item, pr) {
  const incoming = normalizePr(pr);
  return {
    ...item,
    title: incoming.title || item.title,
    url: incoming.url || item.url,
    author: incoming.author || item.author,
    state: pr.state ?? item.state,
    comments: pr.commentsCount == null ? item.comments : incoming.comments,
    createdAt: pr.createdAt ?? item.createdAt,
    updatedAt:
      new Date(incoming.updatedAt) > new Date(item.updatedAt)
        ? incoming.updatedAt
        : item.updatedAt,
    draft: typeof pr.isDraft === "boolean" ? incoming.draft : item.draft,
    labels: incoming.labels.length ? incoming.labels : item.labels,
  };
}

export function addSignal(items, pr, kind, detail = "", href = pr.url) {
  const key = prKey(pr);
  const item = items.has(key) ? mergePr(items.get(key), pr) : normalizePr(pr);
  if (!item.signals.some((signal) => signal.kind === kind)) {
    item.signals.push({
      kind,
      label: signalLabels[kind],
      detail,
      weight: weights[kind],
      href,
    });
  }
  items.set(key, item);
}

export function addSource(items, pr, source, detail = "") {
  const key = prKey(pr);
  const item = items.has(key) ? mergePr(items.get(key), pr) : normalizePr(pr);
  if (source === "notification") {
    item.notification = {
      reason: detail,
      updatedAt: pr.updatedAt,
    };
  }
  if (source === "authored") item.authored = true;
  if (source === "reviewed") item.reviewed = true;
  items.set(key, item);
}

export function trackedPrs(items, prs) {
  return prs.filter((pr) => items.has(prKey(pr)));
}

function lifecycleFor(item) {
  if (item.state === "MERGED") return "merged";
  if (item.draft) return "draft";
  if (item.authored) return "mine";
  if (item.latestReviewState === "APPROVED") return "approved";
  if (item.latestReviewState || item.reviewed) return "reviewed";
  if (item.signals.some((signal) => signal.kind !== "team-covered")) return "new";
  return "other";
}

export function rankItems(items) {
  return [...items.values()]
    .map((item) => {
      const lifecycle = lifecycleFor(item);
      item.signals.sort((a, b) => b.weight - a.weight);
      return {
        ...item,
        lifecycle,
        lifecycleLabel: lifecycleLabels[lifecycle],
        lifecycleScore: lifecycleScores[lifecycle],
        score:
          lifecycleScores[lifecycle] +
          item.signals.reduce((sum, signal) => sum + signal.weight, 0),
        actionUrl: item.signals.find((signal) => signal.weight > 0)?.href ?? item.url,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
}

export function findReviewReply(comments, username) {
  const normalizedUser = username.toLowerCase();
  const threads = new Map();

  for (const comment of comments) {
    const rootId = comment.in_reply_to_id ?? comment.id;
    const thread = threads.get(rootId) ?? [];
    thread.push(comment);
    threads.set(rootId, thread);
  }

  let newestReply = null;
  for (const thread of threads.values()) {
    thread.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const latest = thread.at(-1);
    const latestMine = [...thread]
      .reverse()
      .find((comment) => comment.user?.login?.toLowerCase() === normalizedUser);

    if (
      latestMine &&
      latest?.user?.login?.toLowerCase() !== normalizedUser &&
      new Date(latest.created_at) > new Date(latestMine.created_at) &&
      (!newestReply || new Date(latest.created_at) > new Date(newestReply.created_at))
    ) {
      newestReply = latest;
    }
  }

  return newestReply;
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
    ? [
        ...(activity.comments?.nodes ?? []),
        ...(activity.reviewThreads?.nodes ?? []).flatMap(
          (thread) => thread.comments?.nodes ?? [],
        ),
      ]
        .filter(
          (comment) =>
            comment.author?.login?.toLowerCase() !== normalizedUser &&
            new Date(comment.createdAt) > new Date(activity.mergedAt),
        )
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ?? null
    : null;

  return {
    latestReviewState: latestReview?.state ?? null,
    latestReviewAt,
    newestReply,
    newComment,
    postMergeComment,
    hasNewCommits:
      Boolean(latestReviewAt && lastCommitAt) &&
      new Date(lastCommitAt) > new Date(latestReviewAt),
    coveringTeammate: coveringReview?.author?.login ?? "",
  };
}

async function mapLimited(values, limit, callback) {
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

export function prFromNotification(thread) {
  if (thread.subject?.type !== "PullRequest" || !thread.subject.url) return null;

  try {
    const number = Number.parseInt(new URL(thread.subject.url).pathname.split("/").at(-1), 10);
    const repository = thread.repository?.full_name;
    if (!repository || !Number.isInteger(number)) return null;
    return {
      number,
      title: thread.subject.title,
      url: `https://github.com/${repository}/pull/${number}`,
      repository: { nameWithOwner: repository },
      updatedAt: thread.updated_at,
    };
  } catch {
    return null;
  }
}

function notificationWebUrl(thread) {
  const repositoryUrl =
    thread.repository?.html_url ?? `https://github.com/${thread.repository?.full_name ?? ""}`;
  try {
    const parts = new URL(thread.subject.url).pathname.replace(/^\/repos\//, "").split("/");
    const [owner, repository, resource, value] = parts;
    const route = { pulls: "pull", commits: "commit", issues: "issues", discussions: "discussions" }[
      resource
    ];
    return route && owner && repository && value
      ? `https://github.com/${owner}/${repository}/${route}/${value}`
      : repositoryUrl;
  } catch {
    return repositoryUrl;
  }
}

export function otherNotificationFromThread(thread) {
  if (thread.subject?.type === "PullRequest") return null;
  return {
    id: `notification:${thread.id}`,
    title: thread.subject?.title ?? "GitHub notification",
    url: notificationWebUrl(thread),
    repository: thread.repository?.full_name ?? "GitHub",
    subjectType: thread.subject?.type ?? "Notification",
    reason: thread.reason,
    updatedAt: thread.updated_at,
  };
}

async function getNotifications() {
  const pages = await ghJson([
    "api",
    "--paginate",
    "--slurp",
    "notifications?per_page=50",
  ]);
  const threads = Array.isArray(pages[0]) ? pages.flat() : pages;
  const pullRequests = threads
    .map((thread) => ({ thread, pr: prFromNotification(thread) }))
    .filter(({ pr }) => pr);
  return {
    total: threads.length,
    pullRequests,
    other: threads.map(otherNotificationFromThread).filter(Boolean),
  };
}

async function getPrActivity(pr) {
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

function prFromActivity(item, activity) {
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
    commentsCount: (activity.comments?.totalCount ?? 0) + reviewCommentCount,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
    isDraft: activity.isDraft,
    labels: activity.labels?.nodes ?? [],
  };
}

export async function collectInbox({ username, teammates, teams }) {
  const items = new Map();
  const warnings = [];
  let notifications = [];
  let notificationSummary = { total: 0, pullRequests: 0, nonPullRequests: 0 };
  const tasks = [
    {
      kind: "direct-review",
      args: [`user-review-requested:${username}`],
    },
    {
      kind: "direct-mention",
      args: ["--mentions", username],
    },
    ...teammates
      .filter((person) => person.toLowerCase() !== username.toLowerCase())
      .map((person) => ({
        kind: "teammate-pr",
        detail: person,
        args: ["--author", person],
      })),
    ...teams.flatMap((team) => [
      {
        kind: "team-review",
        detail: team,
        args: [`team-review-requested:${team}`],
      },
      {
        kind: "team-mention",
        detail: team,
        args: ["--team-mentions", team],
      },
    ]),
  ];

  const [notificationsResult, authoredResult, reviewedResult, ...taskResults] =
    await Promise.allSettled([
      getNotifications(),
      searchPrs(["--author", username]),
      searchPrs(["--reviewed-by", username]),
      ...tasks.map(async (task) => ({ task, prs: await searchPrs(task.args) })),
    ]);

  if (notificationsResult.status === "fulfilled") {
    const result = notificationsResult.value;
    notifications = result.other;
    notificationSummary = {
      total: result.total,
      pullRequests: result.pullRequests.length,
      nonPullRequests: result.other.length,
    };
    for (const { thread, pr } of result.pullRequests) {
      addSource(items, pr, "notification", thread.reason);
    }
  } else {
    warnings.push("GitHub notifications could not be loaded.");
  }

  if (authoredResult.status === "fulfilled") {
    for (const pr of authoredResult.value) addSource(items, pr, "authored");
    for (const item of items.values()) {
      if (item.authored && item.notification) addSignal(items, item, "my-pr-activity");
    }
  } else {
    warnings.push("Your pull requests could not be loaded.");
  }

  if (reviewedResult.status === "fulfilled") {
    for (const pr of trackedPrs(items, reviewedResult.value)) {
      addSource(items, pr, "reviewed");
    }
  } else {
    warnings.push("Your reviewed pull requests could not be loaded.");
  }

  for (const result of taskResults) {
    if (result.status === "rejected") {
      warnings.push("One GitHub search could not be loaded.");
      continue;
    }
    const { task, prs } = result.value;
    for (const pr of trackedPrs(items, prs)) {
      const reason = items.get(prKey(pr))?.notification?.reason;
      if (task.kind === "direct-mention" && reason !== "mention") continue;
      if (task.kind === "team-mention" && reason !== "team_mention") continue;
      addSignal(items, pr, task.kind, task.detail);
    }
  }

  // ponytail: inspect the 60 most recently active PRs; raise this if real queues outgrow it.
  const candidates = [...items.values()]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 60);
  const inspected = await mapLimited(candidates, 5, async (item) => {
    try {
      return { item, activity: await getPrActivity(item) };
    } catch {
      return { failed: true };
    }
  });

  let failedInspections = 0;
  for (const result of inspected) {
    if (result.failed) {
      failedInspections++;
      continue;
    }

    const pr = prFromActivity(result.item, result.activity);
    addSource(items, pr, "activity");
    const summary = summarizeActivity(result.activity, username, teammates);
    const item = items.get(prKey(pr));
    item.latestReviewState = summary.latestReviewState;
    item.reviewed ||= Boolean(summary.latestReviewState);
    items.set(item.id, item);

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

    const current = items.get(prKey(pr));
    if (
      summary.newComment &&
      !summary.postMergeComment &&
      !current.signals.some((signal) =>
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
  }
  if (failedInspections) warnings.push("Some pull request activity could not be inspected.");

  return {
    username,
    fetchedAt: new Date().toISOString(),
    items: rankItems(items),
    notifications,
    notificationSummary,
    warnings: [...new Set(warnings)],
  };
}

function secureHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

async function readRequestJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error("Request too large");
  }
  return JSON.parse(body || "{}");
}

async function handleApiRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? host}`);

  if (url.pathname === "/api/settings" && request.method === "GET") {
    response.writeHead(200, secureHeaders("application/json; charset=utf-8"));
    response.end(JSON.stringify(await readSettings()));
    return true;
  }

  if (url.pathname === "/api/settings" && request.method === "PUT") {
    try {
      const settings = await saveSettings(await readRequestJson(request));
      response.writeHead(200, secureHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify(settings));
    } catch {
      response.writeHead(400, secureHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify({ error: "Settings could not be saved." }));
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/inbox") {
    try {
      const saved = await readSettings();
      const username = saved.username || (await getDetectedUser());
      const inbox = await collectInbox({
        username,
        teammates: saved.people,
        teams: saved.teams,
      });
      response.writeHead(200, secureHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify(inbox));
    } catch (error) {
      response.writeHead(502, secureHeaders("application/json; charset=utf-8"));
      response.end(
        JSON.stringify({
          error:
            error?.code === "ENOENT"
              ? "GitHub CLI is not installed."
              : "GitHub could not be reached. Run `gh auth status` and try again.",
        }),
      );
    }
    return true;
  }

  return false;
}

export async function startServer() {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    appType: "spa",
    server: { middlewareMode: true },
  });

  return createHttpServer((request, response) => {
    handleApiRequest(request, response)
      .then((handled) => {
        if (handled) return;
        vite.middlewares(request, response, () => {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not found");
        });
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, secureHeaders("text/plain; charset=utf-8"));
        }
        response.end("Unexpected server error");
      });
  }).listen(port, host, () => {
    console.log(`PR Review Cockpit: http://${host}:${port}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
