import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubAuthoredPullRequestsClient,
  createGitHubNotificationsClient,
  createMarkGitHubNotificationDone,
  notificationSubjectKey,
  prFromAuthoredPullRequest,
  retainInboxNotificationThreads,
} from "../inbox/github-notifications.js";

test("sync lists the REST GitHub inbox", async () => {
  const requests = [];
  const getNotifications = createGitHubNotificationsClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response([
        {
          id: "1",
          unread: true,
          reason: "review_requested",
          subject: {
            type: "PullRequest",
            url: "https://api.github.com/repos/owner/repo/pulls/1",
          },
        },
        {
          id: "2",
          unread: true,
          reason: "review_requested",
          subject: {
            type: "PullRequest",
            url: "https://api.github.com/repos/owner/repo/pulls/2",
          },
        },
      ]);
    },
    getToken: async () => "secret",
  });

  const result = await getNotifications();
  assert.deepEqual(
    result.threads.map(({ id }) => id),
    ["1", "2"],
  );
  assert.equal(new URL(requests[0].url).searchParams.get("all"), "false");
  assert.equal(requests[0].options.headers["If-Modified-Since"], undefined);
});

test("authored pull requests come from a viewer GraphQL query", async () => {
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
  assert.equal(pr.isDraft, true);
  assert.equal(pr.repository.nameWithOwner, "owner/repo");
});

test("REST pull URLs match GitHub inbox HTML URLs", () => {
  assert.equal(
    notificationSubjectKey({
      subject: { url: "https://api.github.com/repos/owner/repo/pulls/23" },
    }),
    "owner/repo#pull:23",
  );
  assert.deepEqual(
    retainInboxNotificationThreads(
      [
        { id: "keep", subject: { url: "https://api.github.com/repos/owner/repo/pulls/23" } },
        { id: "drop", subject: { url: "https://api.github.com/repos/owner/repo/pulls/24" } },
      ],
      new Set(["owner/repo#pull:23"]),
    ).map((thread) => thread.id),
    ["keep"],
  );
});

test("marking a GitHub notification done sends DELETE and accepts an empty 204", async () => {
  const requests = [];
  const markDone = createMarkGitHubNotificationDone({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(null, {}, 204);
    },
    getToken: async () => "secret",
  });

  await markDone("58392017462");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.github.com/notifications/threads/58392017462");
  assert.equal(requests[0].options.method, "DELETE");
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret");
});

test("marking a GitHub notification done treats a missing thread as already done", async () => {
  const markDone = createMarkGitHubNotificationDone({
    fetchImpl: async () => response(null, {}, 404),
    getToken: async () => "secret",
  });
  await markDone("123");
});

test("marking a GitHub notification done rejects unauthorized responses", async () => {
  const markDone = createMarkGitHubNotificationDone({
    fetchImpl: async () => response(null, {}, 403),
    getToken: async () => "secret",
  });
  await assert.rejects(markDone("123"), /HTTP 403/);
});

test("marking a GitHub notification done rejects invalid thread ids without fetching", async () => {
  let fetched = false;
  const markDone = createMarkGitHubNotificationDone({
    fetchImpl: async () => {
      fetched = true;
      return response(null, {}, 204);
    },
    getToken: async () => "secret",
  });
  await assert.rejects(markDone("../1"), /invalid/);
  assert.equal(fetched, false);
});

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
