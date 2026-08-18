import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const apiOrigin = "https://api.github.com";
const maximumPages = 20;
const githubApiVersion = "2026-03-10";

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

export function createGitHubNotificationsClient(options) {
  const auth = createGitHubAuth(options);

  return async function getNotifications({ lastModified, since } = {}) {
    const token = await auth.token();
    const url = new URL("/notifications", apiOrigin);
    url.searchParams.set("all", "true");
    url.searchParams.set("per_page", "100");
    if (since) url.searchParams.set("since", since);

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
  };
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
