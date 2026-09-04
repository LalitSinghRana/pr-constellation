import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const apiOrigin = "https://api.github.com";
const maximumPages = 20;
const githubApiVersion = "2026-03-10";
const graphqlPath = "/graphql";
const defaultInboxPollIntervalSeconds = 60;
const notificationsPath = "/notifications";

const authoredPullRequestsQuery = `query AuthoredOpenPullRequests($first: Int!, $after: String) {
  viewer {
    pullRequests(
      first: $first
      after: $after
      states: [OPEN]
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        number
        title
        url
        isDraft
        state
        reviewDecision
        createdAt
        updatedAt
        mergedAt
        closedAt
        additions
        deletions
        changedFiles
        headRefOid
        author { login }
        repository { nameWithOwner }
        comments { totalCount }
        labels(first: 4) {
          nodes { name color }
        }
      }
    }
  }
}`;

const pullRequestNodeIdQuery = `query PullRequestNodeId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
    }
  }
}`;

const updateSubscriptionMutation = `mutation SubscribeToPullRequest($id: ID!) {
  updateSubscription(input: { subscribableId: $id, state: SUBSCRIBED }) {
    subscribable {
      ... on PullRequest {
        id
      }
    }
  }
}`;

const viewerLoginQuery = `query ViewerLogin {
  viewer {
    login
  }
}`;

const subjectKinds = Object.freeze({
  commit: "commit",
  commits: "commit",
  discussion: "discussions",
  discussions: "discussions",
  issue: "issue",
  issues: "issue",
  pull: "pull",
  pulls: "pull",
});

function defaultGetToken() {
  return exec("gh", ["auth", "token"], {
    encoding: "utf8",
    timeout: 15_000,
  }).then(({ stdout }) => stdout.trim());
}

function githubHeaders(token, extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "pr-constellation",
    "X-GitHub-Api-Version": githubApiVersion,
    ...extra,
  };
}

function createGitHubAuth({ fetchImpl = fetch, getToken = defaultGetToken } = {}) {
  let tokenPromise;

  return {
    fetchImpl,
    resetToken() {
      tokenPromise = undefined;
    },
    async token() {
      tokenPromise ??= Promise.resolve()
        .then(getToken)
        .catch((error) => {
          tokenPromise = undefined;
          throw error;
        });
      const token = await tokenPromise;
      if (!token) throw new Error("GitHub CLI did not return an authentication token.");
      return token;
    },
  };
}

export function notificationSubjectKey(thread) {
  const fromSubject = subjectKeyFromUrl(thread?.subject?.url);
  if (fromSubject) return fromSubject;
  const fromHtml = subjectKeyFromUrl(thread?.url);
  if (fromHtml) return fromHtml;
  const repository =
    typeof thread?.repository === "string"
      ? thread.repository
      : (thread?.repository?.full_name ?? thread?.repository?.nameWithOwner ?? "");
  const type = thread?.subject?.type ?? "";
  const title = thread?.subject?.title ?? thread?.title ?? "";
  if (repository && (type || title)) return `${repository}|${type}|${title}`;
  return thread?.id ? `thread:${thread.id}` : "";
}

export function retainInboxNotificationThreads(threads, inboxKeys) {
  const keys = inboxKeys instanceof Set ? inboxKeys : new Set(inboxKeys);
  return threads.filter((thread) => {
    const key = notificationSubjectKey(thread);
    return Boolean(key) && keys.has(key);
  });
}

export function prFromAuthoredPullRequest(node) {
  const repository = node?.repository?.nameWithOwner || repositoryNameFromUrl(node?.url) || "";
  return {
    additions: node?.additions ?? null,
    author: node?.author ?? null,
    changedFiles: node?.changedFiles ?? null,
    commentsCount: node?.comments?.totalCount ?? 0,
    createdAt: node?.createdAt ?? node?.created_at,
    deletions: node?.deletions ?? null,
    headSha: node?.headRefOid ?? "",
    isDraft: Boolean(node?.isDraft ?? node?.draft),
    labels: node?.labels?.nodes ?? node?.labels ?? [],
    mergedAt: node?.mergedAt ?? node?.merged_at ?? null,
    closedAt: node?.closedAt ?? node?.closed_at ?? null,
    number: node?.number,
    repository: { nameWithOwner: repository },
    reviewDecision: node?.reviewDecision ?? null,
    state: typeof node?.state === "string" ? node.state.toUpperCase() : "OPEN",
    title: node?.title ?? "",
    updatedAt: node?.updatedAt ?? node?.updated_at,
    url: node?.url ?? node?.html_url ?? "",
  };
}

export function threadFromRestNotification(thread) {
  const repository = thread?.repository?.full_name ?? "";
  return {
    id: thread?.id,
    unread: Boolean(thread?.unread),
    reason: typeof thread?.reason === "string" ? thread.reason.toLowerCase() : "",
    updated_at: thread?.updated_at ?? "",
    repository: {
      full_name: repository,
      html_url:
        thread?.repository?.html_url ?? (repository ? `https://github.com/${repository}` : ""),
    },
    subject: {
      title: thread?.subject?.title ?? "",
      type: thread?.subject?.type ?? "",
      url: thread?.subject?.url ?? "",
    },
    url: thread?.url ?? "",
  };
}

function subjectKeyFromUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const parts = url.pathname
      .replace(/^\/repos\//, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 4) return "";
    const [owner, repo, resource, id] = parts;
    const kind = subjectKinds[resource];
    if (!owner || !repo || !kind || !id) return "";
    return `${owner}/${repo}#${kind}:${id}`;
  } catch {
    return "";
  }
}

function repositoryNameFromUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const parts = url.pathname
      .replace(/^\/repos\//, "")
      .split("/")
      .filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
  } catch {
    return "";
  }
}

export function createGitHubNotificationsClient(options = {}) {
  const auth = createGitHubAuth(options);
  return async function getNotifications() {
    return fetchRestNotifications(auth);
  };
}

export function createMarkNotificationThreadReadClient(options = {}) {
  const auth = createGitHubAuth(options);
  return async function markNotificationThreadRead(threadId) {
    return mutateNotificationThread(auth, threadId, "PATCH");
  };
}

export function createMarkNotificationThreadDoneClient(options = {}) {
  const auth = createGitHubAuth(options);
  return async function markNotificationThreadDone(threadId) {
    return mutateNotificationThread(auth, threadId, "DELETE");
  };
}

async function fetchRestNotifications(auth) {
  const token = await auth.token();
  let page = 1;
  let pollIntervalSeconds = defaultInboxPollIntervalSeconds;
  let lastModified = "";
  const threads = [];
  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    const response = await auth.fetchImpl(
      `${apiOrigin}${notificationsPath}?all=true&per_page=50&page=${page}`,
      {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(45_000),
      },
    );
    if ([401, 403].includes(response.status)) auth.resetToken();
    if (!response.ok) throw githubResponseError(response);
    pollIntervalSeconds = positiveInteger(
      response.headers.get("x-poll-interval"),
      pollIntervalSeconds,
    );
    if (!lastModified) lastModified = response.headers.get("last-modified") ?? "";
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("GitHub notifications were unavailable.");
    threads.push(...batch.map(threadFromRestNotification));
    const hasNextPage = Boolean(parseLinkHeader(response.headers.get("link")).next);
    if (!hasNextPage || batch.length === 0) {
      return { lastModified, pollIntervalSeconds, threads };
    }
    page += 1;
  }
  throw new Error(`GitHub REST notifications exceeded ${maximumPages} pages.`);
}

async function mutateNotificationThread(auth, threadId, method) {
  if (!/^\d+$/.test(String(threadId ?? ""))) {
    throw new Error("A numeric GitHub notification thread id is required.");
  }
  const token = await auth.token();
  const response = await auth.fetchImpl(`${apiOrigin}${notificationsPath}/threads/${threadId}`, {
    headers: githubHeaders(token),
    method,
    signal: AbortSignal.timeout(45_000),
  });
  if ([401, 403].includes(response.status)) auth.resetToken();
  if ([204, 205, 304].includes(response.status)) return;
  if (!response.ok) throw githubResponseError(response);
}

function parseLinkHeader(value) {
  const links = {};
  if (typeof value !== "string" || !value) return links;
  for (const part of value.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

export function createGitHubAuthoredPullRequestsClient(options = {}) {
  const auth = createGitHubAuth(options);
  if (typeof options.fetchAuthoredPullRequests === "function") {
    return options.fetchAuthoredPullRequests;
  }
  return async function getAuthoredPullRequests() {
    return fetchGraphqlAuthoredPullRequests(auth);
  };
}

export function createGitHubViewerLoginClient(options = {}) {
  const auth = createGitHubAuth(options);
  return async function getViewerLogin() {
    const token = await auth.token();
    const payload = await graphqlRequest(auth, token, viewerLoginQuery, {});
    const login = payload.data?.viewer?.login;
    if (typeof login !== "string" || !login.trim()) {
      throw new Error("GitHub user login was unavailable.");
    }
    return login;
  };
}

async function fetchGraphqlAuthoredPullRequests(auth) {
  const nodes = await paginateGraphql(auth, authoredPullRequestsQuery, (payload) => {
    const connection = payload.data?.viewer?.pullRequests;
    if (!connection) throw new Error("Your pull requests were unavailable.");
    return connection;
  });
  return nodes.filter(Boolean).map(prFromAuthoredPullRequest);
}

async function paginateGraphql(auth, query, readConnection) {
  const token = await auth.token();
  const nodes = [];
  let after = null;
  for (let page = 0; page < maximumPages; page += 1) {
    const payload = await graphqlRequest(auth, token, query, { after, first: 100 });
    const connection = readConnection(payload);
    nodes.push(...(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) return nodes;
    after = connection.pageInfo.endCursor;
    if (!after) throw new Error("GitHub GraphQL pagination cursor was missing.");
  }
  throw new Error(`GitHub GraphQL exceeded ${maximumPages} pages.`);
}

async function graphqlRequest(auth, token, query, variables) {
  const response = await auth.fetchImpl(`${apiOrigin}${graphqlPath}`, {
    body: JSON.stringify({ query, variables }),
    headers: githubHeaders(token, { "Content-Type": "application/json" }),
    method: "POST",
    signal: AbortSignal.timeout(45_000),
  });
  if ([401, 403].includes(response.status)) auth.resetToken();
  if (!response.ok) throw githubResponseError(response);
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message || "GitHub GraphQL failed.");
  }
  return payload;
}

export function createSubscribeToGitHubIssue(options) {
  const auth = createGitHubAuth(options);

  return async function subscribeToGitHubIssue({ owner, repo, number }) {
    if (
      typeof owner !== "string" ||
      typeof repo !== "string" ||
      !Number.isInteger(number) ||
      number < 1
    ) {
      throw new Error("A GitHub issue subscription target is required.");
    }
    const token = await auth.token();
    const lookup = await graphqlRequest(auth, token, pullRequestNodeIdQuery, {
      name: repo,
      number,
      owner,
    });
    const id = lookup.data?.repository?.pullRequest?.id;
    if (typeof id !== "string" || !id) {
      throw new Error("That pull request could not be loaded from GitHub.");
    }
    await graphqlRequest(auth, token, updateSubscriptionMutation, { id });
  };
}

export const getGitHubNotifications = createGitHubNotificationsClient();
export const getGitHubAuthoredPullRequests = createGitHubAuthoredPullRequestsClient();
export const getGitHubViewerLogin = createGitHubViewerLoginClient();
export const subscribeToGitHubIssue = createSubscribeToGitHubIssue();

function githubResponseError(response) {
  const error = new Error(`GitHub notifications returned HTTP ${response.status}.`);
  const retryAfterSeconds = positiveInteger(response.headers.get("retry-after"), 0);
  if (retryAfterSeconds) error.retryAfterMs = retryAfterSeconds * 1_000;
  return error;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
