import assert from "node:assert/strict";
import test from "node:test";
import { addPinnedInboxPullRequest } from "../inbox/inbox-service/pin-pull-request.js";

test("pinning a pull request stores a pinned inbox row and warns when subscribe fails", async () => {
  const subscribed = [];
  const result = await addPinnedInboxPullRequest("https://github.com/example/app/pull/9", {
    getActivity: async () => ({
      author: { login: "alice" },
      createdAt: "2026-08-01T00:00:00.000Z",
      headRefOid: "abc",
      isDraft: false,
      number: 9,
      state: "OPEN",
      title: "Please review",
      updatedAt: "2026-08-01T00:00:00.000Z",
      url: "https://github.com/example/app/pull/9",
    }),
    mutateQueueState: async (callback) => callback({ items: {} }),
    now: new Date("2026-08-20T12:00:00.000Z"),
    subscribeToIssue: async (target) => {
      subscribed.push(target);
      throw new Error("GitHub subscription failed");
    },
  });

  assert.equal(result.id, "example/app#9");
  assert.equal(result.pinned, true);
  assert.equal(result.slug, "gh-7-example-3-app-9");
  assert.equal(result.lifecycle, "new");
  assert.equal(result.repository, "example/app");
  assert.equal(result.title, "Please review");
  assert.equal(result.authored, false);
  assert.match(result.warning, /could not subscribe/);
  assert.deepEqual(subscribed, [{ number: 9, owner: "example", repo: "app" }]);
});

test("pinning scores an approved review for the detected GitHub user", async () => {
  const result = await addPinnedInboxPullRequest("https://github.com/example/app/pull/9", {
    getActivity: async () => ({
      author: { login: "alice" },
      createdAt: "2026-08-01T00:00:00.000Z",
      headRefOid: "abc",
      isDraft: false,
      number: 9,
      reviews: {
        nodes: [
          {
            author: { login: "me" },
            state: "APPROVED",
            submittedAt: "2026-08-20T11:00:00.000Z",
          },
        ],
      },
      state: "OPEN",
      title: "Please review",
      updatedAt: "2026-08-20T12:00:00.000Z",
      url: "https://github.com/example/app/pull/9",
    }),
    mutateQueueState: async (callback) => callback({ items: {} }),
    now: new Date("2026-08-20T12:00:00.000Z"),
    teammates: ["alice"],
    teams: ["example/platform"],
    username: "me",
  });

  assert.equal(result.lifecycle, "approved");
  assert.equal(result.latestReviewState, "APPROVED");
  assert.equal(
    result.signals.some((signal) => signal.kind === "teammate-pr"),
    true,
  );
});

test("pinning ranks the persisted queue row the same way the inbox list does", async () => {
  const result = await addPinnedInboxPullRequest("https://github.com/example/app/pull/9", {
    getActivity: async () => ({
      author: { login: "alice" },
      createdAt: "2026-08-01T00:00:00.000Z",
      headRefOid: "abc",
      isDraft: false,
      mergedAt: "2026-08-18T00:00:00.000Z",
      number: 9,
      state: "MERGED",
      title: "Landed",
      updatedAt: "2026-08-18T00:00:00.000Z",
      url: "https://github.com/example/app/pull/9",
    }),
    mutateQueueState: async (callback) => callback({ items: {} }),
    now: new Date("2026-08-20T12:00:00.000Z"),
  });

  assert.equal(result.lifecycle, "merged");
  assert.equal(result.state, "MERGED");
  assert.equal(result.done, false);
  assert.equal(result.repository, "example/app");
  assert.equal(result.title, "Landed");
  assert.equal(result.pinned, true);
});

test("pinning rejects a non-GitHub pull request URL", async () => {
  await assert.rejects(
    () =>
      addPinnedInboxPullRequest("https://example.com/pull/1", {
        mutateQueueState: async () => ({}),
      }),
    { status: 400 },
  );
});
