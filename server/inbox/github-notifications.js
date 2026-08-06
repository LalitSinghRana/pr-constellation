import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const apiOrigin = "https://api.github.com";
const maximumPages = 20;

export function createGitHubNotificationsClient({
  fetchImpl = fetch,
  getToken = async () => {
    const { stdout } = await exec("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return stdout.trim();
  },
} = {}) {
  let tokenPromise;

  return async function getNotifications({ lastModified, since } = {}) {
    tokenPromise ??= getToken().catch((error) => {
      tokenPromise = undefined;
      throw error;
    });
    const token = await tokenPromise;
    if (!token) throw new Error("GitHub CLI did not return an authentication token.");

    const url = new URL("/notifications", apiOrigin);
    url.searchParams.set("all", "true");
    url.searchParams.set("per_page", "100");
    if (since) url.searchParams.set("since", since);

    const threads = [];
    let nextUrl = url.href;
    let responseLastModified = "";
    let pollIntervalSeconds = 60;
    for (let page = 0; nextUrl && page < maximumPages; page += 1) {
      const response = await fetchImpl(nextUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          ...(page === 0 && lastModified ? { "If-Modified-Since": lastModified } : {}),
          "User-Agent": "pr-review-cockpit",
          "X-GitHub-Api-Version": "2026-03-10",
        },
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
      if ([401, 403].includes(response.status)) tokenPromise = undefined;
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

export const getGitHubNotifications = createGitHubNotificationsClient();

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
