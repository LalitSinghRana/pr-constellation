import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DashboardService } from "../analysis/dashboard-service.js";

test("dashboard orders queued runs by band, score, and manual prioritize", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pr-queue-priority-"));
  const reviewsDir = path.join(temporaryRoot, ".reviews");
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const service = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      modelProviders: { "gpt-fixture": "codex" },
      modelReasoningEfforts: { "gpt-fixture": ["xhigh"] },
      reasoningEfforts: ["xhigh"],
    },
    getCodeVersion: async () => ({
      commit: "abc",
      dirty: false,
      fingerprint: "abc",
    }),
    publishReview: async () => {},
    reviewsDir,
    runExecutor: async ({ signal }) => {
      await gate;
      if (signal.aborted) throw signal.reason;
      return {
        metadata: { headRefOid: "sha-fixture" },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  });
  await service.initialize();

  try {
    const blocker = await service.enqueue({
      inboxScore: 1,
      prUrl: "https://github.com/example/hold/pull/9",
      queueBand: "none",
      refresh: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const refresh = await service.enqueue({
      inboxScore: 50,
      prUrl: "https://github.com/example/old/pull/1",
      queueBand: "past-success",
      refresh: true,
    });
    const freshLow = await service.enqueue({
      additions: 10,
      deletions: 0,
      inboxScore: 5,
      prUrl: "https://github.com/example/new/pull/2",
      queueBand: "none",
      refresh: true,
    });
    const freshHigh = await service.enqueue({
      additions: 100,
      deletions: 0,
      inboxScore: 20,
      prUrl: "https://github.com/example/new/pull/3",
      queueBand: "none",
      refresh: true,
    });

    let snapshot = await service.snapshot();
    assert.equal(snapshot.queue.activeRunIds.includes(blocker.runId), true);
    assert.deepEqual(snapshot.queue.queuedRunIds, [freshHigh.runId, freshLow.runId, refresh.runId]);

    await service.prioritizeRun({ runId: refresh.runId, slug: refresh.slug });
    snapshot = await service.snapshot();
    assert.deepEqual(snapshot.queue.queuedRunIds, [refresh.runId, freshHigh.runId, freshLow.runId]);

    const prioritized = snapshot.prs
      .flatMap((pr) => pr.runs)
      .find((run) => run.runId === refresh.runId);
    assert.equal(typeof prioritized?.metrics?.bumpedAt, "string");

    for (const run of snapshot.prs.flatMap((pr) => pr.runs)) {
      if (!["queued", "running"].includes(run.status)) continue;
      try {
        await service.cancelRun({ runId: run.runId, slug: run.slug });
      } catch {
        // already finished or removed
      }
    }
    release();
    await service.waitForIdle();
  } finally {
    release();
    await service.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
