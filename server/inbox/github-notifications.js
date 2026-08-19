import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const apiOrigin = "https://api.github.com";
const maximumPages = 20;
const githubApiVersion = "2026-03-10";
const graphqlPath = "/graphql";

const inboxThreadsQuery = `query InboxNotificationThreads($first: Int!, $after: String) {
  viewer {
    notificationThreads(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        databaseId
        isArchived
        isUnread
        lastUpdatedAt
        reason
        title
        url
        subject {
          __typename
          ... on PullRequest {
            number
            title
            url
            repository { nameWithOwner }
          }
          ... on Issue {
            number
            title
            url
            repository { nameWithOwner }
          }
          ... on Discussion {
            number
            title
            url
            repository { nameWithOwner }
          }
          ... on Commit {
            url
            repository { nameWithOwner }
          }
          ... on Release {
            name
            url
            repository { nameWithOwner }
          }
        }
      }
    }
  }
}`;

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

const graphqlSubjectTypes = Object.freeze({
  Commit: "Commit",
  Discussion: "Discussion",
  Issue: "Issue",
  PullRequest: "PullRequest",
  Release: "Release",
  CheckSuite: "CheckSuite",
  WorkflowRun: "WorkflowRun",
  RepositoryInvitation: "RepositoryInvitation",
});

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
    "User-Agent": "pr-review-cockpit",
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

export function inboxKeyFromGraphqlNode(node) {
  const thread = threadFromGraphqlNode(node);
  return thread ? notificationSubjectKey(thread) : "";
}

export function threadFromGraphqlNode(node) {
  if (!node || node.isArchived) return null;
  const subject = node.subject ?? {};
  const type = graphqlSubjectTypes[subject.__typename] ?? subject.__typename ?? "";
  const subjectUrl = subject.url || node.url || "";
  const repository = subject.repository?.nameWithOwner || repositoryNameFromUrl(subjectUrl) || "";
  const title = subject.title || subject.name || node.title || "";
  const id = node.databaseId == null ? "" : String(node.databaseId);
  if (!subjectUrl && !id) return null;
  return {
    id: id || `graphql:${node.url || title}`,
    reason: normalizeNotificationReason(node.reason),
    repository: {
      full_name: repository,
      html_url: repository ? `https://github.com/${repository}` : "",
    },
    subject: {
      title,
      type: type || "PullRequest",
      url: subjectUrl,
    },
    unread: Boolean(node.isUnread),
    updated_at: node.lastUpdatedAt,
  };
}

export function retainInboxNotificationThreads(threads, inboxKeys) {
  const keys = inboxKeys instanceof Set ? inboxKeys : new Set(inboxKeys);
  return threads.filter((thread) => {
    const key = notificationSubjectKey(thread);
    return Boolean(key) && keys.has(key);
  });
}

export function unreadNotificationThreads(threads) {
  return threads.filter((thread) => thread?.unread);
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
    number: node?.number,
    repository: { nameWithOwner: repository },
    reviewDecision: node?.reviewDecision ?? null,
    state: typeof node?.state === "string" ? node.state.toUpperCase() : "OPEN",
    title: node?.title ?? "",
    updatedAt: node?.updatedAt ?? node?.updated_at,
    url: node?.url ?? node?.html_url ?? "",
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

function normalizeNotificationReason(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replaceAll("-", "_");
}

export function createGitHubNotificationsClient(options = {}) {
  const auth = createGitHubAuth(options);
  const fetchInbox =
    options.fetchInboxThreads === undefined
      ? () => fetchGraphqlInboxThreads(auth)
      : options.fetchInboxThreads;

  return async function getNotifications({ lastModified } = {}) {
    if (typeof fetchInbox === "function") {
      try {
        const inbox = await fetchInbox();
        if (!Array.isArray(inbox?.threads)) {
          throw new Error("GitHub inbox threads were unavailable.");
        }
        return {
          lastModified: inbox.lastModified ?? "",
          membership: "inbox",
          notModified: false,
          pollIntervalSeconds: inbox.pollIntervalSeconds ?? 60,
          threads: inbox.threads,
        };
      } catch {
        // Fall through to unread REST when GraphQL inbox is unavailable.
      }
    }
    const rest = await fetchRestNotificationThreads(auth, { lastModified });
    if (rest.notModified) return rest;
    return {
      ...rest,
      membership: "unread",
      threads: unreadNotificationThreads(rest.threads),
    };
  };
}

export function createGitHubAuthoredPullRequestsClient(options = {}) {
  const auth = createGitHubAuth(options);
  const fetchAuthored =
    options.fetchAuthoredPullRequests === undefined
      ? () => fetchGraphqlAuthoredPullRequests(auth)
      : options.fetchAuthoredPullRequests;

  return async function getAuthoredPullRequests() {
    if (typeof fetchAuthored === "function") {
      try {
        return await fetchAuthored();
      } catch {
        // Fall through to REST search when GraphQL authored PRs are unavailable.
      }
    }
    return fetchRestAuthoredPullRequests(auth);
  };
}

async function fetchGraphqlInboxThreads(auth) {
  const nodes = await paginateGraphql(auth, inboxThreadsQuery, (payload) => {
    const connection = payload.data?.viewer?.notificationThreads;
    if (!connection) throw new Error("GitHub inbox threads were unavailable.");
    return connection;
  });
  return {
    lastModified: "",
    pollIntervalSeconds: 60,
    threads: nodes.map(threadFromGraphqlNode).filter(Boolean),
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

async function fetchRestNotificationThreads(auth, { lastModified } = {}) {
  const token = await auth.token();
  const url = new URL("/notifications", apiOrigin);
  url.searchParams.set("all", "false");
  url.searchParams.set("per_page", "100");

  const threads = [];
  let nextUrl = url.href;
  let responseLastModified = "";
  let pollIntervalSeconds = 60;
  for (let page = 0; nextUrl && page < maximumPages; page += 1) {
    const response = await auth.fetchImpl(nextUrl, {
      headers: githubHeaders(
        token,
        page === 0 && lastModified ? { "If-Modified-Since": lastModified } : {},
      ),
      signal: AbortSignal.timeout(45_000),
    });
    pollIntervalSeconds = positiveInteger(
      response.headers.get("x-poll-interval"),
      pollIntervalSeconds,
    );
    if (response.status === 304) {
      return {
        lastModified,
        membership: "unread",
        notModified: true,
        pollIntervalSeconds,
        threads: [],
      };
    }
    if ([401, 403].includes(response.status)) auth.resetToken();
    if (!response.ok) throw githubResponseError(response);

    responseLastModified ||= response.headers.get("last-modified") ?? "";
    const pageThreads = await response.json();
    if (!Array.isArray(pageThreads)) throw new Error("GitHub notifications were not an array.");
    threads.push(...pageThreads);
    nextUrl = nextLink(response.headers.get("link"));
  }

  if (nextUrl) throw new Error(`GitHub notifications exceeded ${maximumPages} pages.`);
  return {
    lastModified: responseLastModified,
    notModified: false,
    pollIntervalSeconds,
    threads,
  };
}

async function fetchRestAuthoredPullRequests(auth) {
  const token = await auth.token();
  const items = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const url = new URL("/search/issues", apiOrigin);
    url.searchParams.set("q", "is:pr is:open author:@me");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await auth.fetchImpl(url.href, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(45_000),
    });
    if ([401, 403].includes(response.status)) auth.resetToken();
    if (!response.ok) throw githubResponseError(response);
    const payload = await response.json();
    const pageItems = Array.isArray(payload.items) ? payload.items : [];
    items.push(...pageItems);
    if (pageItems.length < 100) break;
  }
  return items.map((item) =>
    prFromAuthoredPullRequest({
      author: item.user,
      createdAt: item.created_at,
      draft: Boolean(item.draft),
      html_url: item.html_url,
      number: item.number,
      repository: { nameWithOwner: repositoryNameFromUrl(item.html_url || item.repository_url) },
      state: item.state,
      title: item.title,
      updatedAt: item.updated_at,
    }),
  );
}

export function createMarkGitHubNotificationDone(options) {
  const auth = createGitHubAuth(options);

  return async function markGitHubNotificationDone(threadId) {
    const id = typeof threadId === "string" || typeof threadId === "number" ? String(threadId) : "";
    if (!/^\d+$/.test(id)) throw new Error("GitHub notification thread id is invalid.");

    const token = await auth.token();
    const response = await auth.fetchImpl(`${apiOrigin}/notifications/threads/${id}`, {
      headers: githubHeaders(token),
      method: "DELETE",
      signal: AbortSignal.timeout(45_000),
    });
    if (response.status === 404) return;
    if ([401, 403].includes(response.status)) auth.resetToken();
    if (!response.ok) throw githubResponseError(response);
  };
}

export const getGitHubNotifications = createGitHubNotificationsClient();
export const getGitHubAuthoredPullRequests = createGitHubAuthoredPullRequestsClient();
export const markGitHubNotificationThreadDone = createMarkGitHubNotificationDone();

function nextLink(value) {
  if (!value) return "";
  for (const part of value.split(",")) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (!match?.[2].split(/\s+/).includes("next")) continue;
    const url = new URL(match[1]);
    if (url.origin !== apiOrigin) throw new Error("GitHub returned an unsafe pagination URL.");
    return url.href;
  }
  return "";
}

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
