import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisHistoryBand,
  compareAnalysisQueueJobs,
  sortAnalysisQueueJobs,
} from "../../shared/analysis-queue-policy.js";
import { sortAnalysisCandidates } from "../inbox/inbox-service/analysis-queue.js";

test("analysis history band classifies none, fail/cancel, and success", () => {
  assert.equal(analysisHistoryBand([]), "none");
  assert.equal(analysisHistoryBand([{ status: "queued" }]), "none");
  assert.equal(analysisHistoryBand([{ status: "failed" }]), "past-fail-cancel");
  assert.equal(analysisHistoryBand([{ status: "canceled" }]), "past-fail-cancel");
  assert.equal(
    analysisHistoryBand([{ status: "failed" }, { status: "succeeded" }]),
    "past-success",
  );
});

test("queue jobs drain by band then score then size", () => {
  const ordered = sortAnalysisQueueJobs([
    {
      runId: "refresh-low",
      queueBand: "past-success",
      inboxScore: 20,
      additions: 1,
      deletions: 0,
    },
    {
      runId: "none-high",
      queueBand: "none",
      inboxScore: 15,
      additions: 100,
      deletions: 0,
    },
    {
      runId: "none-low",
      queueBand: "none",
      inboxScore: 3,
      additions: 2,
      deletions: 0,
    },
    {
      runId: "bumped",
      queueBand: "none",
      inboxScore: 0,
      bumpedAt: "2026-08-12T12:00:00.000Z",
      additions: 999,
      deletions: 0,
    },
    {
      runId: "failed",
      queueBand: "past-fail-cancel",
      inboxScore: 50,
      additions: 1,
      deletions: 0,
    },
  ]);

  assert.deepEqual(
    ordered.map((job) => job.runId),
    ["bumped", "none-high", "none-low", "failed", "refresh-low"],
  );
});

test("sortAnalysisCandidates prefers never-analyzed high-signal over past success", () => {
  const historyByUrl = new Map([
    ["https://github.com/example/repo/pull/1", [{ status: "succeeded" }]],
    ["https://github.com/example/repo/pull/2", []],
    ["https://github.com/example/repo/pull/3", [{ status: "canceled" }]],
  ]);
  const ordered = sortAnalysisCandidates(
    [
      {
        url: "https://github.com/example/repo/pull/1",
        score: 30,
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      },
      {
        url: "https://github.com/example/repo/pull/2",
        score: 8,
        additions: 40,
        deletions: 0,
        changedFiles: 2,
      },
      {
        url: "https://github.com/example/repo/pull/3",
        score: 25,
        additions: 2,
        deletions: 0,
        changedFiles: 1,
      },
    ],
    historyByUrl,
  );

  assert.deepEqual(
    ordered.map((item) => item.url),
    [
      "https://github.com/example/repo/pull/2",
      "https://github.com/example/repo/pull/3",
      "https://github.com/example/repo/pull/1",
    ],
  );
});

test("compareAnalysisQueueJobs keeps batch index order for the same PR batch", () => {
  assert.ok(
    compareAnalysisQueueJobs(
      { slug: "a", batchId: "batch-1", batchIndex: 0, queueBand: "none", inboxScore: 0 },
      { slug: "a", batchId: "batch-1", batchIndex: 1, queueBand: "none", inboxScore: 99 },
    ) < 0,
  );
});
