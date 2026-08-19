import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInboxStore } from "../inbox/inbox-store.js";

test("inbox store imports JSON once and persists row-level mutations", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-inbox-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const queuePath = path.join(root, "queue.json");
  const settingsPath = path.join(root, "settings.json");
  const databasePath = path.join(root, "state", "cockpit.sqlite3");
  const initial = queueState({
    active: queueRecord("active", "2026-01-02T00:00:00.000Z"),
    done: {
      ...queueRecord("done", "2026-01-01T00:00:00.000Z"),
      doneVersion: "2026-01-01T00:00:00.000Z",
    },
  });
  await Promise.all([
    writeFile(queuePath, JSON.stringify(initial)),
    writeFile(settingsPath, JSON.stringify({ username: "octocat" })),
  ]);

  const store = await createInboxStore({
    databasePath,
    legacyQueuePath: queuePath,
    legacySettingsPath: settingsPath,
  });
  context.after(() => store.close());

  assert.deepEqual(store.queueCounts(), { active: 1, done: 1, total: 2 });
  assert.deepEqual(Object.keys(store.readQueueState({ view: "active" }).items), ["active"]);
  assert.equal(store.readSettings().username, "octocat");

  await store.mutateQueueState(
    (state) => {
      state.items.active.doneVersion = state.items.active.version;
    },
    { ids: ["active"] },
  );
  assert.deepEqual(store.queueCounts(), { active: 0, done: 2, total: 2 });

  await writeFile(
    queuePath,
    JSON.stringify(queueState({ replacement: queueRecord("replacement") })),
  );
  store.close();
  const reopened = await createInboxStore({
    databasePath,
    legacyQueuePath: queuePath,
    legacySettingsPath: settingsPath,
  });
  context.after(() => reopened.close());
  assert.deepEqual(
    new Set(Object.keys(reopened.readQueueState().items)),
    new Set(["active", "done"]),
  );
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  assert.ok((await readFile(queuePath, "utf8")).includes("replacement"));
});

test("inbox store pages completed items newest first", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-inbox-page-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await createInboxStore({ databasePath: path.join(root, "cockpit.sqlite3") });
  context.after(() => store.close());
  const state = queueState({
    old: doneRecord("old", "2026-01-01T00:00:00.000Z"),
    new: doneRecord("new", "2026-01-03T00:00:00.000Z"),
    middle: doneRecord("middle", "2026-01-02T00:00:00.000Z"),
  });
  await store.mutateQueueState((current) => Object.assign(current, state));

  assert.deepEqual(Object.keys(store.readQueueState({ view: "done", limit: 2 }).items), [
    "new",
    "middle",
  ]);
  assert.deepEqual(Object.keys(store.readQueueState({ view: "done", limit: 2, offset: 2 }).items), [
    "old",
  ]);
});

test("inbox store pages every active item and counts categories across pages", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-inbox-active-page-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await createInboxStore({ databasePath: path.join(root, "cockpit.sqlite3") });
  context.after(() => store.close());

  const items = Object.fromEntries(
    Array.from({ length: 1_001 }, (_, index) => {
      const id = `new-${String(index).padStart(4, "0")}`;
      const record = queueRecord(id);
      record.item.state = "OPEN";
      record.item.signals = [];
      return [id, record];
    }),
  );
  items.reviewed = categoryRecord("reviewed", { reviewed: true });
  items.approved = categoryRecord("approved", { latestReviewState: "APPROVED" });
  items.mergedMine = categoryRecord("merged-mine", { authored: true, state: "MERGED" });
  items.other = categoryRecord("other", {
    state: "CLOSED",
    signals: [{ kind: "team-covered" }],
  });
  items.notification = categoryRecord("notification", { kind: "notification" });
  items.done = {
    ...categoryRecord("done", { state: "OPEN" }),
    doneVersion: "2026-01-01T00:00:00.000Z",
  };
  await store.mutateQueueState((state) => Object.assign(state, queueState(items)));

  const firstPage = store.readQueueState({ view: "active", limit: 1_000 });
  const secondPage = store.readQueueState({ view: "active", limit: 1_000, offset: 1_000 });
  assert.equal(Object.keys(firstPage.items).length, 1_000);
  assert.equal(Object.keys(secondPage.items).length, 6);
  assert.deepEqual(store.queueCounts(), { active: 1_006, done: 1, total: 1_007 });
  assert.deepEqual(store.activeQueueCounts(), {
    approved: 1,
    closed: 1,
    draft: 0,
    merged: 1,
    mine: 0,
    new: 1_001,
    nonpr: 1,
    other: 0,
    reviewed: 1,
  });
});

test("row-level mutations can advance sync metadata without replacing the queue", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-inbox-sync-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await createInboxStore({ databasePath: path.join(root, "cockpit.sqlite3") });
  context.after(() => store.close());
  await store.mutateQueueState((state) =>
    Object.assign(state, queueState({ existing: queueRecord("existing") })),
  );

  await store.mutateQueueState(
    (state) => {
      state.sync.notificationsSyncedAt = "2026-01-04T00:00:00.000Z";
      state.items.added = queueRecord("added", "2026-01-04T00:00:00.000Z");
    },
    { ids: ["added"], updateSync: true },
  );

  const state = store.readQueueState();
  assert.deepEqual(new Set(Object.keys(state.items)), new Set(["existing", "added"]));
  assert.equal(state.sync.notificationsSyncedAt, "2026-01-04T00:00:00.000Z");
});

function queueState(items) {
  return {
    version: 2,
    sync: {
      lastSyncedAt: "2026-01-03T00:00:00.000Z",
      username: "octocat",
      repositories: ["example/repo"],
    },
    items,
  };
}

function queueRecord(id, updatedAt = "2026-01-01T00:00:00.000Z") {
  return {
    version: updatedAt,
    updatedAt,
    item: {
      id,
      repository: "example/repo",
      updatedAt,
    },
  };
}

function doneRecord(id, updatedAt) {
  return { ...queueRecord(id, updatedAt), doneVersion: updatedAt };
}

function categoryRecord(id, item) {
  const record = queueRecord(id);
  record.item = { ...record.item, signals: [], ...item };
  return record;
}
