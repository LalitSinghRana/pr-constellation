import assert from "node:assert/strict";
import test from "node:test";
import { createSyncScheduler } from "../inbox/sync-scheduler.js";

test("sync scheduler polls the same sync callback on each tick", async () => {
  const calls = [];
  const scheduler = createSyncScheduler({
    onError: () => {},
    setTimer: () => ({ unref() {} }),
    sync: async () => {
      calls.push("sync");
      return { pollIntervalSeconds: 60 };
    },
  });

  await scheduler.runNow();
  await scheduler.runNow();
  await scheduler.runSync();

  assert.deepEqual(calls, ["sync", "sync", "sync"]);
});

test("sync scheduler keeps overlapping triggers single-flight", async () => {
  let finish;
  let calls = 0;
  const scheduler = createSyncScheduler({
    onError: () => {},
    setTimer: () => ({ unref() {} }),
    sync: () =>
      new Promise((resolve) => {
        calls += 1;
        finish = resolve;
      }),
  });

  const first = scheduler.runNow();
  const second = scheduler.runSync();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish();
  await first;
});

test("stopping waits for the in-flight synchronization", async () => {
  let finish;
  const scheduler = createSyncScheduler({
    onError: () => {},
    setTimer: () => ({ unref() {} }),
    sync: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });

  scheduler.runSync();
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
