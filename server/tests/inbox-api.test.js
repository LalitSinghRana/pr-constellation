import assert from "node:assert/strict";
import test from "node:test";
import { createInboxApi } from "../inbox/inbox-service/api.js";
import {
  applySettingsPatch,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
} from "../inbox/inbox-service.js";

test("marking inbox items done writes to GitHub when a numeric thread id is known", async () => {
  const githubCalls = [];
  const { body, status } = await putInboxItems(
    { id: "example/app#1", done: true },
    {
      items: {
        "example/app#1": pullRequestRecord("example/app#1", "25388832108"),
        "notification:NT_55": notificationRecord("NT_55"),
      },
      syncInboxDoneToGitHub: async (targets) => {
        githubCalls.push(targets);
      },
    },
  );

  assert.equal(status, 200);
  assert.equal(body.done, true);
  assert.equal(body.warning, undefined);
  assert.deepEqual(githubCalls, [[{ id: "example/app#1", threadId: "25388832108" }]]);
});

test("marking inbox items done warns when no numeric GitHub thread id is known", async () => {
  const { body, status } = await putInboxItems(
    { id: "example/app#1", done: true },
    {
      items: {
        "example/app#1": pullRequestRecord("example/app#1", "NT_99"),
      },
    },
  );

  assert.equal(status, 200);
  assert.equal(body.done, true);
  assert.match(body.warning, /no notification thread id is known/);
});

test("marking a non-PR notification done writes to GitHub with its thread id", async () => {
  const githubCalls = [];
  const { body } = await putInboxItems(
    { id: "notification:25388832109", done: true },
    {
      items: { "notification:25388832109": notificationRecord("25388832109") },
      syncInboxDoneToGitHub: async (targets) => {
        githubCalls.push(targets);
      },
    },
  );

  assert.equal(body.done, true);
  assert.deepEqual(githubCalls, [[{ id: "notification:25388832109", threadId: "25388832109" }]]);
});

test("marking inbox items read writes to GitHub when a numeric thread id is known", async () => {
  const githubCalls = [];
  const { body, status } = await putInboxItems(
    { id: "example/app#1", read: true },
    {
      items: {
        "example/app#1": pullRequestRecord("example/app#1", "25388832108"),
      },
      syncInboxReadToGitHub: async (targets) => {
        githubCalls.push(targets);
      },
    },
  );

  assert.equal(status, 200);
  assert.equal(body.read, true);
  assert.deepEqual(githubCalls, [[{ id: "example/app#1", threadId: "25388832108" }]]);
});

test("marking several items done warns when some GitHub writes fail", async () => {
  const { body } = await putInboxItems(
    { ids: ["example/app#1", "example/app#2"], done: true },
    {
      items: {
        "example/app#1": pullRequestRecord("example/app#1", "25388832108"),
        "example/app#2": pullRequestRecord("example/app#2", "25388832109"),
      },
      syncInboxDoneToGitHub: async (targets) => {
        assert.equal(targets.length, 2);
        return "GitHub could not mark done: example/app#2.";
      },
    },
  );

  assert.equal(body.done, true);
  assert.equal(body.warning, "GitHub could not mark done: example/app#2.");
});

test("adding an inbox pull request rejects an invalid URL", async () => {
  const { body, status } = await postInboxItems(
    { url: "https://example.com/not-a-pr" },
    {
      addInboxPullRequest: async () => {
        const error = new Error("A GitHub pull request URL is required.");
        error.status = 400;
        throw error;
      },
    },
  );
  assert.equal(status, 400);
  assert.equal(body.error, "A GitHub pull request URL is required.");
});

test("adding an inbox pull request returns the pinned item", async () => {
  const { body, status } = await postInboxItems(
    { url: "https://github.com/example/app/pull/9" },
    {
      addInboxPullRequest: async (url) => ({
        id: "example/app#9",
        pinned: true,
        slug: "gh-7-example-3-app-9",
        url,
      }),
    },
  );
  assert.equal(status, 200);
  assert.equal(body.pinned, true);
  assert.equal(body.id, "example/app#9");
});

test("adding an inbox pull request uses the resolved GitHub username and team settings", async () => {
  const calls = [];
  const { status } = await postInboxItems(
    { url: "https://github.com/example/app/pull/9" },
    {
      addInboxPullRequest: async (url, options) => {
        calls.push({ options, url });
        return { id: "example/app#9", pinned: true, url };
      },
      readSettings: async () => ({
        people: ["alice"],
        teams: ["example/platform"],
        username: "",
      }),
      resolveGitHubUsername: async () => "me",
    },
  );
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {
    teammates: ["alice"],
    teams: ["example/platform"],
    username: "me",
  });
});

test("PUT /api/settings cannot replace the stored GitHub username", async () => {
  let stored = applySettingsPatch(
    { username: "me", people: ["alice"], teams: ["example/platform"] },
    {},
  );
  const { body, status } = await requestJson(
    "PUT",
    "/api/settings",
    {
      autoQueue: true,
      people: ["bob"],
      teams: [],
      username: "other",
    },
    {
      readSettings: async () => stored,
      saveSettings: async (value, options) => {
        stored = applySettingsPatch(stored, value, options);
        return stored;
      },
    },
  );
  assert.equal(status, 200);
  assert.equal(body.username, "me");
  assert.deepEqual(body.people, ["bob"]);
  assert.deepEqual(body.teams, []);
  assert.equal(body.autoQueue, true);
  assert.equal(stored.username, "me");
});

test("GET /api/inbox uses the resolved GitHub username", async () => {
  const { body, status } = await requestJson("GET", "/api/inbox", undefined, {
    getInboxStore: async () => ({
      activeQueueCounts: () => ({ active: 0 }),
      queueCounts: () => ({ active: 0, done: 0 }),
    }),
    inboxFromQueue: (_state, username) => ({
      items: [],
      notifications: [],
      username,
    }),
    readQueueState: async () => ({ items: {}, sync: { username: "stale" } }),
    resolveGitHubUsername: async () => "me",
  });
  assert.equal(status, 200);
  assert.equal(body.username, "me");
});

async function putInboxItems(payload, extras = {}) {
  return requestInboxItems("PUT", payload, extras);
}

async function postInboxItems(payload, extras = {}) {
  return requestInboxItems("POST", payload, extras);
}

async function requestInboxItems(method, payload, extras = {}) {
  return requestJson(method, "/api/inbox/items", payload, extras);
}

async function requestJson(
  method,
  url,
  payload,
  {
    addInboxPullRequest,
    getInboxStore,
    inboxFromQueue,
    items = {},
    readQueueState,
    readSettings,
    resolveGitHubUsername,
    saveSettings,
    syncInboxDoneToGitHub,
    syncInboxReadToGitHub,
  } = {},
) {
  const handleApiRequest = createInboxApi({
    addInboxPullRequest,
    getInboxStore: getInboxStore ?? (async () => ({})),
    inboxFromQueue: inboxFromQueue ?? ((state) => state),
    mutateQueueState: async (callback) => callback({ items }),
    readQueueState: readQueueState ?? (async () => ({ items })),
    readSettings: readSettings ?? (async () => ({})),
    resolveGitHubUsername,
    saveSettings: saveSettings ?? (async (value) => value),
    setQueueItemDone,
    setQueueItemRead,
    setQueueItemsDone,
    syncInboxDoneToGitHub,
    syncInboxReadToGitHub,
  });
  const response = new FakeResponse();
  const handled = await handleApiRequest(
    payload === undefined ? emptyRequest(method, url) : jsonRequest(method, url, payload),
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
      notificationThreadId: threadId,
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

function emptyRequest(method, url) {
  return {
    async *[Symbol.asyncIterator]() {},
    headers: { host: "127.0.0.1:4397" },
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
