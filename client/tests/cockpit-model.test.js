import assert from "node:assert/strict";
import test from "node:test";
import { analysisState, analysisTimeline, formatDuration } from "../src/lib/analysis.js";
import { groupByUpdatedDate, myPullRequestStatus } from "../src/lib/queue.js";

test("analysis entries have one visible section", () => {
  assert.equal(analysisState({ runningRun: {}, queuedRuns: [{}], latestRun: null }), "running");
  assert.equal(analysisState({ runningRun: null, queuedRuns: [{}], latestRun: null }), "queued");
  assert.equal(analysisState({ runningRun: null, queuedRuns: [], latestRun: null }), "not-started");
  assert.equal(
    analysisState({ runningRun: null, queuedRuns: [], latestRun: { status: "succeeded" } }),
    "completed",
  );
  assert.equal(
    analysisState({ runningRun: null, queuedRuns: [], latestRun: { status: "failed" } }),
    "failed",
  );
});

test("analysis timeline nests and aligns live analysis stages", () => {
  const run = {
    timings: {
      stages: [
        {
          stageId: "input.fetch",
          label: "Fetch PR",
          status: "completed",
          durationMs: 2_000,
          endedAt: "2026-01-01T00:00:02Z",
        },
        {
          stageId: "analysis",
          label: "Analysis",
          parentStageId: "run.total",
          status: "running",
          durationMs: 0,
          startedAt: "2026-01-01T00:00:10Z",
          endedAt: null,
          attempt: 1,
        },
        {
          stageId: "analysis.review-stacks",
          label: "Review Stacks",
          parentStageId: "analysis",
          status: "completed",
          durationMs: 10_000,
          startedAt: "2026-01-01T00:00:10Z",
          endedAt: "2026-01-01T00:00:20Z",
          attempt: 1,
        },
        {
          stageId: "analysis.attempt-1",
          label: "Analysis attempt 1",
          parentStageId: "analysis",
          status: "running",
          durationMs: 0,
          startedAt: "2026-01-01T00:00:20Z",
          endedAt: null,
          attempt: 1,
        },
        {
          stageId: "analysis.attempt-1.generate-review-trees",
          label: "Generate Review Trees",
          parentStageId: "analysis.attempt-1",
          status: "running",
          durationMs: 0,
          startedAt: "2026-01-01T00:00:20Z",
          endedAt: null,
          attempt: 1,
        },
        {
          stageId: "analysis.attempt-1.evaluation.judge-candidate",
          label: "AI semantic judge",
          status: "skipped",
          durationMs: 0,
          endedAt: "2026-01-01T00:00:20Z",
          attempt: 1,
        },
        {
          stageId: "render",
          label: "Render",
          status: "completed",
          durationMs: 100,
          endedAt: "2026-01-01T00:00:21Z",
        },
      ],
    },
  };

  const timeline = analysisTimeline(run, Date.parse("2026-01-01T00:01:10Z"));
  assert.equal(timeline.durationMs, 60_000);
  assert.deepEqual(
    timeline.rows.map(({ label, depth, durationMs, running }) => ({
      label,
      depth,
      durationMs,
      running,
    })),
    [
      { label: "Analysis", depth: 0, durationMs: 60_000, running: true },
      { label: "Review Stacks", depth: 1, durationMs: 10_000, running: false },
      { label: "Analysis attempt 1", depth: 1, durationMs: 50_000, running: true },
      { label: "Generate Review Trees", depth: 2, durationMs: 50_000, running: true },
    ],
  );
  assert.equal(Math.round(timeline.rows[1].widthPct), 17);
  assert.equal(Math.round(timeline.rows[2].offsetPct), 17);
  assert.equal(formatDuration(3_720_000), "1h 2m");
});

test("analysis date groups preserve queue order", () => {
  const items = [
    { id: "first", updatedAt: "2026-08-05T10:00:00Z" },
    { id: "second", updatedAt: "2026-08-05T11:00:00Z" },
  ];
  assert.deepEqual(
    groupByUpdatedDate(items, { preserveOrder: true })[0].items.map((item) => item.id),
    ["first", "second"],
  );
});

test("my pull request shows one highest-priority status", () => {
  assert.equal(myPullRequestStatus({ draft: true, state: "OPEN" }), "draft");
  assert.equal(myPullRequestStatus({ draft: false, state: "OPEN" }), "opened");
  assert.equal(
    myPullRequestStatus({ draft: true, reviewDecision: "APPROVED", state: "OPEN" }),
    "approved",
  );
  assert.equal(
    myPullRequestStatus({ draft: true, reviewDecision: "APPROVED", state: "MERGED" }),
    "merged",
  );
});
