import assert from "node:assert/strict";
import test from "node:test";
import { createSyncScheduler } from "../inbox/sync-scheduler.js";

test("sync scheduler reconciles first, then performs lightweight notification polls", async () => {
  let currentTime = 100;
  const calls = [];
  const scheduler = createSyncScheduler({
    fullSync: async () => calls.push("full"),
    notificationSync: async () => calls.push("notifications"),
    now: () => currentTime,
    onError: () => {},
    setTimer: () => ({ unref() {} }),
  });

  await scheduler.runNow();
  currentTime += 5 * 60_000;
  await scheduler.runNow();
  currentTime += 60 * 60_000;
  await scheduler.runNow();

  assert.deepEqual(calls, ["full", "notifications", "full"]);
});

test("sync scheduler keeps overlapping triggers single-flight", async () => {
  let finish;
  let calls = 0;
  const scheduler = createSyncScheduler({
    fullSync: () =>
      new Promise((resolve) => {
        calls += 1;
        finish = resolve;
      }),
    notificationSync: async () => {},
    onError: () => {},
    setTimer: () => ({ unref() {} }),
  });

  const first = scheduler.runNow();
  const second = scheduler.runNotificationSync();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish();
  await first;
});

test("stopping waits for the in-flight synchronization", async () => {
  let finish;
  const scheduler = createSyncScheduler({
    fullSync: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    notificationSync: async () => {},
    onError: () => {},
    setTimer: () => ({ unref() {} }),
  });

  scheduler.runFullSync();
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish();
  await stopping;
  assert.equal(stopped, true);
});

test("a requested full reconciliation follows an active notification poll", async () => {
  let finishNotification;
  const calls = [];
  const scheduler = createSyncScheduler({
    fullSync: async () => calls.push("full"),
    notificationSync: () =>
      new Promise((resolve) => {
        calls.push("notifications");
        finishNotification = resolve;
      }),
    onError: () => {},
    setTimer: () => ({ unref() {} }),
  });

  scheduler.runNotificationSync();
  const full = scheduler.runFullSync();
  assert.deepEqual(calls, ["notifications"]);
  finishNotification();
  await full;
  assert.deepEqual(calls, ["notifications", "full"]);
});

test("stopping cancels a queued reconciliation and waits for its triggering poll", async () => {
  let finishNotification;
  const calls = [];
  const scheduler = createSyncScheduler({
    fullSync: async () => calls.push("full"),
    notificationSync: () =>
      new Promise((resolve) => {
        calls.push("notifications");
        finishNotification = resolve;
      }),
    onError: () => {},
    setTimer: () => ({ unref() {} }),
  });

  scheduler.runNotificationSync();
  const queuedFull = scheduler.runFullSync();
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);

  finishNotification();
  await Promise.all([queuedFull, stopping]);

  assert.equal(stopped, true);
  assert.deepEqual(calls, ["notifications"]);
});
