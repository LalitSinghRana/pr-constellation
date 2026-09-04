import { spawn } from "node:child_process";

const reviewThreadsQuery = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        reviewThreads(first: 100) {
          nodes {
            isResolved
            isOutdated
            path
            line
            startLine
            diffSide
            comments(first: 50) {
              nodes {
                databaseId
                author { login avatarUrl }
                body
                createdAt
                url
              }
            }
          }
        }
      }
    }
  }
`;

const pullRequestConversationQuery = `
  query($owner: String!, $name: String!, $number: Int!, $threadCursor: String, $timelineCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        timelineItems(first: 100, after: $timelineCursor) {
          pageInfo { endCursor hasNextPage }
          nodes {
            __typename
            ... on IssueComment { databaseId body createdAt url author { login avatarUrl } }
            ... on PullRequestReview { databaseId body state submittedAt url author { login avatarUrl } }
            ... on PullRequestCommit { commit { oid message authoredDate url author { user { login avatarUrl } } } }
            ... on MergedEvent { createdAt actor { login avatarUrl } }
            ... on ClosedEvent { createdAt actor { login avatarUrl } }
            ... on ReopenedEvent { createdAt actor { login avatarUrl } }
            ... on ReadyForReviewEvent { createdAt actor { login avatarUrl } }
            ... on HeadRefForcePushedEvent { createdAt actor { login avatarUrl } }
            ... on ReviewRequestedEvent {
              createdAt
              actor { login avatarUrl }
              requestedReviewer {
                ... on User { login }
                ... on Team { name }
              }
            }
            ... on CrossReferencedEvent { createdAt actor { login avatarUrl } }
          }
        }
        reviewThreads(first: 100, after: $threadCursor) {
          pageInfo { endCursor hasNextPage }
          nodes {
            isResolved
            isOutdated
            path
            line
            comments(first: 100) {
              nodes { databaseId body createdAt url author { login avatarUrl } }
            }
          }
        }
      }
    }
  }
`;

export async function checkGitHubWriteAccess({ runGh = runGhJson } = {}) {
  try {
    const { stdout } = await runGh(["auth", "status"], { parseJson: false });
    const scopes = parseGhTokenScopes(stdout);
    const canWrite = scopes.includes("repo") || scopes.includes("public_repo");
    return {
      canWrite,
      ok: stdout.includes("Logged in"),
      scopes,
    };
  } catch (error) {
    return {
      canWrite: false,
      error:
        error?.code === "ENOENT" ? "GitHub CLI is not installed." : "GitHub is not authenticated.",
      ok: false,
      scopes: [],
    };
  }
}

export function parseGhTokenScopes(stdout) {
  const scopeLine = String(stdout || "")
    .split("\n")
    .find((line) => /token scopes:/i.test(line));
  if (!scopeLine) {
    return [];
  }
  return [...scopeLine.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

export async function fetchReviewThreads({ number, owner, repo, runGh = runGhJson } = {}) {
  const response = await runGh([
    "api",
    "graphql",
    "-f",
    `query=${reviewThreadsQuery}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${repo}`,
    "-F",
    `number=${number}`,
  ]);
  const pullRequest = response?.data?.repository?.pullRequest;
  return {
    headSha: pullRequest?.headRefOid || null,
    threads: (pullRequest?.reviewThreads?.nodes || []).map(normalizeReviewThread),
  };
}

export async function fetchPullRequestConversation({
  number,
  owner,
  repo,
  runGh = runGhJson,
} = {}) {
  const timeline = new Map();
  const threads = new Map();
  let threadCursor = null;
  let timelineCursor = null;

  // ponytail: cap at 1,000 items per connection; add an explicit load-more UI if a PR reaches it.
  for (let page = 0; page < 10; page += 1) {
    const response = await runGh([
      "api",
      "graphql",
      "-f",
      `query=${pullRequestConversationQuery}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${repo}`,
      "-F",
      `number=${number}`,
      ...(threadCursor ? ["-f", `threadCursor=${threadCursor}`] : []),
      ...(timelineCursor ? ["-f", `timelineCursor=${timelineCursor}`] : []),
    ]);
    const pullRequest = response?.data?.repository?.pullRequest;
    for (const item of pullRequest?.timelineItems?.nodes || []) {
      const normalized = normalizeConversationItem(item);
      if (normalized)
        timeline.set(`${normalized.type}:${normalized.id}:${normalized.createdAt}`, normalized);
    }
    for (const thread of pullRequest?.reviewThreads?.nodes || []) {
      const normalized = normalizeConversationThread(thread);
      threads.set(
        `${normalized.path}:${normalized.line}:${normalized.comments[0]?.id}`,
        normalized,
      );
    }
    timelineCursor = pullRequest?.timelineItems?.pageInfo?.hasNextPage
      ? pullRequest.timelineItems.pageInfo.endCursor
      : null;
    threadCursor = pullRequest?.reviewThreads?.pageInfo?.hasNextPage
      ? pullRequest.reviewThreads.pageInfo.endCursor
      : null;
    if (!timelineCursor && !threadCursor) break;
  }

  return {
    timeline: [...timeline.values()],
    threads: [...threads.values()],
  };
}

/**
 * Submit a pull-request review in one GitHub API call.
 *
 * Uses path + line + side (current GitHub review-comment shape). Do not send
 * deprecated `position`, and do not create a PENDING review first — both were
 * sources of the prior 400/422 failures.
 */
export async function submitPullRequestReview({
  body = "",
  comments = [],
  event,
  headSha,
  number,
  owner,
  repo,
  runGh = runGhJson,
} = {}) {
  const normalizedEvent = normalizeReviewEvent(event);
  const normalizedBody = String(body || "").trim();
  const replyComments = comments.filter((comment) => Number(comment?.replyToCommentId) > 0);
  const lineDraftComments = comments.filter((comment) => !Number(comment?.replyToCommentId));
  const reviewComments = buildReviewComments(lineDraftComments);

  if (
    reviewComments.length === 0 &&
    replyComments.length === 0 &&
    !normalizedBody &&
    normalizedEvent !== "APPROVE"
  ) {
    throw new Error("A review summary is required when submitting without line comments.");
  }

  if (!owner || !repo || !number) {
    throw new Error("Pull request owner, repo, and number are required.");
  }

  await dismissOwnPendingReview({ number, owner, repo, runGh });

  const postedReplies = [];
  for (const reply of replyComments) {
    postedReplies.push(
      await postReviewCommentReply({
        body: reply.body,
        number,
        owner,
        replyToCommentId: reply.replyToCommentId,
        repo,
        runGh,
      }),
    );
  }

  if (reviewComments.length === 0 && !normalizedBody && normalizedEvent === "APPROVE") {
    return runGh(
      ["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-"],
      {
        input: JSON.stringify({
          commit_id: typeof headSha === "string" && headSha.trim() ? headSha.trim() : undefined,
          event: normalizedEvent,
        }),
      },
    );
  }

  if (reviewComments.length === 0 && replyComments.length > 0 && !normalizedBody) {
    const lastReply = postedReplies.at(-1);
    return {
      html_url: lastReply?.html_url || null,
      state: "COMMENTED",
      submitted_at: new Date().toISOString(),
    };
  }

  const payload = {
    comments: reviewComments,
    event: normalizedEvent,
  };
  if (normalizedBody) {
    payload.body = normalizedBody;
  }
  if (typeof headSha === "string" && headSha.trim()) {
    payload.commit_id = headSha.trim();
  }

  return runGh(
    ["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-"],
    { input: JSON.stringify(payload) },
  );
}

export function buildReviewComments(comments = []) {
  return comments.map((comment, index) => {
    const path = typeof comment?.path === "string" ? comment.path.trim() : "";
    const body = typeof comment?.body === "string" ? comment.body.trim() : "";
    const side = String(comment?.side || "").toUpperCase();
    const line = Number(comment?.line);

    if (!path) {
      throw new Error(`Draft comment ${index + 1} is missing a file path.`);
    }
    if (!body) {
      throw new Error(`Draft comment ${index + 1} is missing a body.`);
    }
    if (!Number.isInteger(line) || line < 1) {
      throw new Error(`Draft comment ${index + 1} has an invalid line number.`);
    }
    if (side !== "LEFT" && side !== "RIGHT") {
      throw new Error(`Draft comment ${index + 1} must use side "LEFT" or "RIGHT".`);
    }

    return { body, line, path, side };
  });
}

async function postReviewCommentReply({
  body,
  number,
  owner,
  replyToCommentId,
  repo,
  runGh = runGhJson,
}) {
  const normalizedBody = String(body || "").trim();
  const parentId = Number(replyToCommentId);
  if (!normalizedBody) {
    throw new Error("Reply body is required.");
  }
  if (!Number.isInteger(parentId) || parentId < 1) {
    throw new Error("A valid parent review comment id is required for replies.");
  }

  return runGh(
    ["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/comments`, "--input", "-"],
    {
      input: JSON.stringify({
        body: normalizedBody,
        in_reply_to: parentId,
      }),
    },
  );
}

async function dismissOwnPendingReview({ number, owner, repo, runGh }) {
  const reviews = await runGh([
    "api",
    `repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
  ]);
  const pending = (Array.isArray(reviews) ? reviews : []).filter(
    (review) => review?.state === "PENDING",
  );

  for (const review of pending) {
    await runGh([
      "api",
      "--method",
      "DELETE",
      `repos/${owner}/${repo}/pulls/${number}/reviews/${review.id}`,
    ]);
  }
}

function normalizeReviewThread(thread) {
  const comments = (thread?.comments?.nodes || []).map((comment) => ({
    authorLogin: comment?.author?.login || "",
    avatarUrl: comment?.author?.avatarUrl || "",
    body: comment?.body || "",
    createdAt: comment?.createdAt || "",
    databaseId: Number(comment?.databaseId) || null,
    url: comment?.url || "",
  }));
  return {
    comments,
    diffSide: thread?.diffSide || "RIGHT",
    isOutdated: Boolean(thread?.isOutdated),
    isResolved: Boolean(thread?.isResolved),
    line: thread?.line ?? null,
    path: thread?.path || "",
    startLine: thread?.startLine ?? null,
  };
}

function normalizeConversationItem(item) {
  const actor = item?.author || item?.actor || item?.commit?.author?.user;
  const base = {
    actor: actor?.login || "GitHub",
    avatarUrl: actor?.avatarUrl || "",
    createdAt: item?.createdAt || item?.submittedAt || item?.commit?.authoredDate || "",
    type: item?.__typename || "",
    url: item?.url || item?.commit?.url || "",
  };

  if (item?.__typename === "IssueComment") {
    return { ...base, body: item.body || "", id: item.databaseId || null, kind: "comment" };
  }
  if (item?.__typename === "PullRequestReview") {
    return {
      ...base,
      body: item.body || "",
      id: item.databaseId || null,
      kind: "review",
      state: item.state || "COMMENTED",
    };
  }
  if (item?.__typename === "PullRequestCommit") {
    return {
      ...base,
      body: item.commit?.message || "",
      id: item.commit?.oid || null,
      kind: "commit",
    };
  }
  if (item?.__typename?.endsWith("Event")) {
    return {
      ...base,
      body: "",
      id: null,
      kind: "event",
      requestedReviewer: item.requestedReviewer?.login || item.requestedReviewer?.name || "",
    };
  }
  return null;
}

function normalizeConversationThread(thread) {
  return {
    comments: (thread?.comments?.nodes || []).map((comment) => ({
      actor: comment?.author?.login || "GitHub",
      avatarUrl: comment?.author?.avatarUrl || "",
      body: comment?.body || "",
      createdAt: comment?.createdAt || "",
      id: comment?.databaseId || null,
      url: comment?.url || "",
    })),
    isOutdated: Boolean(thread?.isOutdated),
    isResolved: Boolean(thread?.isResolved),
    line: thread?.line ?? null,
    path: thread?.path || "",
  };
}

function normalizeReviewEvent(event) {
  const normalized = String(event || "COMMENT").toUpperCase();
  if (normalized === "APPROVE" || normalized === "REQUEST_CHANGES" || normalized === "COMMENT") {
    return normalized;
  }
  throw new Error('Review event must be "APPROVE", "REQUEST_CHANGES", or "COMMENT".');
}

async function runGhJson(args, { input, parseJson = true } = {}) {
  const { stderr, stdout } = await runGhProcess(args, input);
  if (!parseJson) {
    return { stderr, stdout };
  }
  try {
    return JSON.parse(stdout || "null");
  } catch {
    throw new Error(stderr.trim() || stdout.trim() || "GitHub CLI returned non-JSON output.");
  }
}

function runGhProcess(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr, stdout });
        return;
      }
      reject(createGhError({ args, code, stderr, stdout }));
    });

    if (input == null) {
      child.stdin.end();
      return;
    }
    child.stdin.end(input);
  });
}

function createGhError({ args, code, stderr, stdout }) {
  const apiMessage = extractGitHubErrorMessage(stdout, stderr);
  const command = ["gh", ...args].join(" ");
  const error = new Error(apiMessage || `GitHub CLI failed (${command}).`);
  error.code = "GITHUB_API";
  error.exitCode = code;
  error.stderr = stderr;
  error.stdout = stdout;
  return error;
}

function extractGitHubErrorMessage(stdout, stderr) {
  const fromJson = parseGitHubErrorJson(stdout);
  if (fromJson) return fromJson;

  const stderrText = String(stderr || "").trim();
  if (stderrText) {
    return stderrText.replace(/^gh:\s*/i, "GitHub: ");
  }
  return String(stdout || "").trim();
}

function parseGitHubErrorJson(stdout) {
  try {
    const payload = JSON.parse(String(stdout || ""));
    if (!payload || typeof payload !== "object") return "";
    const errors = Array.isArray(payload.errors)
      ? payload.errors
          .map((entry) => (typeof entry === "string" ? entry : entry?.message))
          .filter(Boolean)
          .join("; ")
      : "";
    if (errors) return `GitHub: ${errors}`;
    if (typeof payload.message === "string" && payload.message.trim()) {
      return `GitHub: ${payload.message.trim()}`;
    }
  } catch {
    // Response was not JSON.
  }
  return "";
}
