import assert from "node:assert/strict";
import test from "node:test";
import { createInboxApi, githubNotificationThreadIds } from "../inbox/inbox-service/api.js";
import { setQueueItemDone, setQueueItemRead, setQueueItemsDone } from "../inbox/inbox-service.js";

function validNotificationThreadId(value) {
  const id = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^\d+$/.test(id) ? id : null;
}

test("queue items resolve GitHub notification thread ids from records and ids", () => {
  assert.deepEqual(
    githubNotificationThreadIds(
      {
        items: {
          "example/app#1": { item: { notificationThreadId: "99" } },
          "notification:55": { item: {} },
          "example/app#2": { item: {} },
        },
      },
      ["example/app#1", "notification:55", "example/app#2"],
      validNotificationThreadId,
    ),
    { missing: ["example/app#2"], threadIds: ["99", "55"] },
  );
});

test("marking inbox items done also marks GitHub notification threads", async () => {
  const marked = [];
  const { body, status } = await putInboxItems(
    { id: "example/app#1", done: true },
    {
      items: {
        "example/app#1": pullRequestRecord("example/app#1", "99"),
        "notification:55": notificationRecord("55"),
      },
      markGitHubNotificationDone: async (threadId) => {
        marked.push(threadId);
      },
    },
  );

  assert.equal(status, 200);
  assert.equal(body.done, true);
  assert.equal(body.warning, undefined);
  assert.deepEqual(marked, ["99"]);
});

test("marking a non-PR notification done uses the thread id from the queue id", async () => {
  const marked = [];
  const { body } = await putInboxItems(
    { id: "notification:55", done: true },
    {
      items: { "notification:55": notificationRecord("55") },
      markGitHubNotificationDone: async (threadId) => {
        marked.push(threadId);
      },
    },
  );

  assert.equal(body.done, true);
  assert.deepEqual(marked, ["55"]);
});

test("marking several items done still marks known GitHub threads when lookup fails", async () => {
  const marked = [];
  const { body } = await putInboxItems(
    { ids: ["example/app#1", "example/app#2"], done: true },
    {
      getNotifications: async () => {
        throw new Error("GitHub notifications unavailable");
      },
      items: {
        "example/app#1": pullRequestRecord("example/app#1", "99"),
        "example/app#2": pullRequestRecord("example/app#2"),
      },
      markGitHubNotificationDone: async (threadId) => {
        marked.push(threadId);
      },
    },
  );

  assert.equal(body.done, true);
  assert.equal(body.warning, "Saved locally, but GitHub could not mark the notification done.");
  assert.deepEqual(marked, ["99"]);
});

test("a GitHub mark-done failure still saves the local done state", async () => {
  const { body, status } = await putInboxItems(
    { id: "notification:55", done: true },
    {
      items: { "notification:55": notificationRecord("55") },
      markGitHubNotificationDone: async () => {
        throw new Error("GitHub notifications returned HTTP 403.");
      },
    },
  );

  assert.equal(status, 200);
  assert.equal(body.done, true);
  assert.equal(body.warning, "Saved locally, but GitHub could not mark the notification done.");
});

test("marking inbox items done looks up missing thread ids from live notifications", async () => {
  const marked = [];
  const { body } = await putInboxItems(
    { id: "example/app#1", done: true },
    {
      getNotifications: async () => ({
        pullRequests: [
          { pr: { number: 1, repository: "example/app", notificationThreadId: "77" } },
        ],
        other: [],
      }),
      items: { "example/app#1": pullRequestRecord("example/app#1") },
      markGitHubNotificationDone: async (threadId) => {
        marked.push(threadId);
      },
    },
  );

  assert.equal(body.warning, undefined);
  assert.deepEqual(marked, ["77"]);
});

async function putInboxItems(payload, { getNotifications, items, markGitHubNotificationDone }) {
  const handleApiRequest = createInboxApi({
    getInboxStore: async () => ({}),
    getNotifications: getNotifications ?? (async () => ({ other: [], pullRequests: [] })),
    inboxFromQueue: (state) => state,
    markGitHubNotificationDone,
    mutateQueueState: async (callback) => callback({ items }),
    prKey: (pr) =>
      `${typeof pr.repository === "string" ? pr.repository : pr.repository.nameWithOwner}#${pr.number}`,
    readQueueState: async () => ({ items }),
    readSettings: async () => ({}),
    saveSettings: async (value) => value,
    setQueueItemDone,
    setQueueItemRead,
    setQueueItemsDone,
    validNotificationThreadId,
  });
  const response = new FakeResponse();
  const handled = await handleApiRequest(
    jsonRequest("PUT", "/api/inbox/items", payload),
    response,
    {
      eventHub: { publish() {} },
    },
  );
  assert.equal(handled, true);
  return { body: JSON.parse(response.body.toString()), status: response.status };
}

function pullRequestRecord(id, notificationThreadId) {
  const updatedAt = "2026-01-01T00:00:00Z";
  const [, number] = /#(\d+)$/.exec(id);
  return {
    item: {
      id,
      notificationThreadId,
      number: Number(number),
      repository: "example/app",
      updatedAt,
      url: `https://github.com/example/app/pull/${number}`,
    },
    updatedAt,
    version: updatedAt,
  };
}

function notificationRecord(threadId) {
  const updatedAt = "2026-01-01T00:00:00Z";
  return {
    item: {
      id: `notification:${threadId}`,
      kind: "notification",
      title: "Issue comment",
      unread: true,
      updatedAt,
      url: "https://github.com/example/app/issues/1",
    },
    updatedAt,
    version: `${updatedAt}:unread`,
  };
}

function jsonRequest(method, url, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
    headers: { "content-type": "application/json", host: "127.0.0.1:4397" },
    method,
    url,
  };
}

class FakeResponse {
  body = Buffer.alloc(0);
  status = null;

  end(value) {
    if (value) this.write(value);
  }

  write(value) {
    this.body = Buffer.concat([this.body, Buffer.from(value)]);
  }

  writeHead(status) {
    this.status = status;
  }
}
