import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubAuthoredPullRequestsClient,
  createGitHubNotificationsClient,
  createGitHubViewerLoginClient,
  createMarkNotificationThreadDoneClient,
  createMarkNotificationThreadReadClient,
  createSubscribeToGitHubIssue,
  notificationSubjectKey,
  prFromAuthoredPullRequest,
  retainInboxNotificationThreads,
  threadFromRestNotification,
} from "../inbox/github-notifications.js";

test("sync lists the REST GitHub inbox with all=true", async () => {
  const requests = [];
  const getNotifications = createGitHubNotificationsClient({
    fetchImpl: async (url, options) => {
      requests.push({ options, url });
      return response(
        [restPullThread({ id: "101", number: 1 }), restPullThread({ id: "102", number: 2 })],
        {
          "last-modified": "Thu, 20 Aug 2026 13:37:58 GMT",
          link: "",
          "x-poll-interval": "60",
        },
      );
    },
    getToken: async () => "secret",
  });

  const result = await getNotifications();
  assert.deepEqual(
    result.threads.map(({ id }) => id),
    ["101", "102"],
  );
  assert.equal(result.threads[0].reason, "review_requested");
  assert.equal(result.threads[0].unread, true);
  assert.equal(result.threads[0].subject.type, "PullRequest");
  assert.equal(result.threads[0].repository.full_name, "owner/repo");
  assert.equal(result.pollIntervalSeconds, 60);
  assert.equal(result.lastModified, "Thu, 20 Aug 2026 13:37:58 GMT");
  assert.match(requests[0].url, /\/notifications\?all=true&per_page=50&page=1$/);
  assert.equal(requests[0].options.method, undefined);
});

test("REST inbox listing paginates until the last page", async () => {
  const requests = [];
  const getNotifications = createGitHubNotificationsClient({
    fetchImpl: async (url) => {
      requests.push(url);
      if (requests.length === 1) {
        return response([restPullThread({ id: "101", number: 1 })], {
          link: '<https://api.github.com/notifications?all=true&per_page=50&page=2>; rel="next"',
        });
      }
      return response([restPullThread({ id: "102", number: 2 })], { link: "" });
    },
    getToken: async () => "secret",
  });

  const result = await getNotifications();
  assert.deepEqual(
    result.threads.map(({ id }) => id),
    ["101", "102"],
  );
  assert.match(requests[0], /page=1$/);
  assert.match(requests[1], /page=2$/);
});

test("REST notification reasons and subjects map to the inbox thread shape", () => {
  const thread = threadFromRestNotification({
    id: "55",
    reason: "team_mention",
    unread: false,
    updated_at: "2026-08-21T12:00:00Z",
    repository: {
      full_name: "example/app",
      html_url: "https://github.com/example/app",
    },
    subject: {
      title: "Keep all notifications",
      type: "Issue",
      url: "https://api.github.com/repos/example/app/issues/7",
    },
    url: "https://api.github.com/notifications/threads/55",
  });
  assert.equal(thread.id, "55");
  assert.equal(thread.unread, false);
  assert.equal(thread.reason, "team_mention");
  assert.equal(thread.subject.type, "Issue");
  assert.equal(thread.subject.url, "https://api.github.com/repos/example/app/issues/7");
});

test("marking a notification thread read uses PATCH", async () => {
  const requests = [];
  const markRead = createMarkNotificationThreadReadClient({
    fetchImpl: async (url, options) => {
      requests.push({ options, url });
      return response(null, {}, 205);
    },
    getToken: async () => "secret",
  });
  await markRead("25388832108");
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/notifications/threads/25388832108");
  assert.equal(requests[0].options.method, "PATCH");
});

test("marking a notification thread done uses DELETE", async () => {
  const requests = [];
  const markDone = createMarkNotificationThreadDoneClient({
    fetchImpl: async (url, options) => {
      requests.push({ options, url });
      return response(null, {}, 204);
    },
    getToken: async () => "secret",
  });
  await markDone("25388832108");
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/notifications/threads/25388832108");
  assert.equal(requests[0].options.method, "DELETE");
});

test("authored pull requests come from a viewer GraphQL query", async () => {
  const requests = [];
  const getAuthored = createGitHubAuthoredPullRequestsClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response({
        data: {
          viewer: {
            pullRequests: {
              nodes: [
                {
                  author: { login: "me" },
                  isDraft: true,
                  number: 23,
                  repository: { nameWithOwner: "owner/repo" },
                  state: "OPEN",
                  title: "Mine",
                  url: "https://github.com/owner/repo/pull/23",
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      });
    },
    getToken: async () => "secret",
  });

  const [pr] = await getAuthored();
  assert.equal(pr.number, 23);
  assert.equal(pr.isDraft, true);
  assert.equal(pr.repository.nameWithOwner, "owner/repo");
  assert.equal(new URL(requests[0].url).pathname, "/graphql");
  assert.equal(new URL(requests[0].url).pathname.includes("search"), false);
});

test("authored pull requests do not fall back to REST search", async () => {
  const getAuthored = createGitHubAuthoredPullRequestsClient({
    fetchAuthoredPullRequests: async () => [
      prFromAuthoredPullRequest({
        author: { login: "me" },
        isDraft: true,
        number: 23,
        repository: { nameWithOwner: "owner/repo" },
        state: "OPEN",
        title: "Mine",
        url: "https://github.com/owner/repo/pull/23",
      }),
    ],
    fetchImpl: async () => {
      throw new Error("REST should not run");
    },
    getToken: async () => "secret",
  });

  const [pr] = await getAuthored();
  assert.equal(pr.number, 23);
});

test("viewer login comes from a GraphQL query", async () => {
  const getLogin = createGitHubViewerLoginClient({
    fetchImpl: async () =>
      response({
        data: { viewer: { login: "octocat" } },
      }),
    getToken: async () => "secret",
  });
  assert.equal(await getLogin(), "octocat");
});

test("HTML pull URLs match GitHub inbox HTML URLs", () => {
  assert.equal(
    notificationSubjectKey({
      subject: { url: "https://github.com/owner/repo/pull/23" },
    }),
    "owner/repo#pull:23",
  );
  assert.deepEqual(
    retainInboxNotificationThreads(
      [
        { id: "keep", subject: { url: "https://github.com/owner/repo/pull/23" } },
        { id: "drop", subject: { url: "https://github.com/owner/repo/pull/24" } },
      ],
      new Set(["owner/repo#pull:23"]),
    ).map((thread) => thread.id),
    ["keep"],
  );
});

test("subscribing to a pull request uses updateSubscription", async () => {
  const requests = [];
  const subscribe = createSubscribeToGitHubIssue({
    fetchImpl: async (url, options) => {
      requests.push({ options, url });
      const query = JSON.parse(options.body).query;
      if (query.includes("PullRequestNodeId")) {
        return response({
          data: { repository: { pullRequest: { id: "PR_9" } } },
        });
      }
      return response({
        data: { updateSubscription: { subscribable: { id: "PR_9" } } },
      });
    },
    getToken: async () => "secret",
  });
  await subscribe({ number: 9, owner: "example", repo: "app" });
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).pathname, "/graphql");
  assert.match(JSON.parse(requests[0].options.body).query, /pullRequest/);
  assert.match(JSON.parse(requests[1].options.body).query, /updateSubscription/);
  assert.equal(JSON.parse(requests[1].options.body).variables.id, "PR_9");
});

function restPullThread({ id, number, reason = "review_requested" }) {
  return {
    id,
    reason,
    unread: true,
    updated_at: "2026-08-21T12:00:00Z",
    repository: {
      full_name: "owner/repo",
      html_url: "https://github.com/owner/repo",
    },
    subject: {
      title: `Pull ${number}`,
      type: "PullRequest",
      url: `https://api.github.com/repos/owner/repo/pulls/${number}`,
    },
    url: `https://api.github.com/notifications/threads/${id}`,
  };
}

function response(body, headers = {}, status = 200) {
  return {
    headers: new Headers(headers),
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}
