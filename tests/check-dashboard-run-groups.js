import assert from "node:assert/strict";
import { groupRunsForDisplay } from "../src/dashboard-run-groups.js";

const runs = [
  fixtureRun("a-high", "2026-01-01T10:00:03.000Z", {
    batchId: "batch-a",
    batchIndex: 2,
  }),
  fixtureRun("legacy-new", "2026-01-01T10:00:05.000Z"),
  fixtureRun("b-medium", "2026-01-01T10:00:04.000Z", {
    batchId: "batch-b",
    batchIndex: 1,
    topLevel: true,
  }),
  fixtureRun("a-low", "2026-01-01T10:00:01.000Z", {
    batchId: "batch-a",
    batchIndex: 0,
  }),
  fixtureRun("legacy-old", "2026-01-01T09:59:59.000Z"),
  fixtureRun("b-low", "2026-01-01T10:00:02.000Z", {
    batchId: "batch-b",
    batchIndex: 0,
    topLevel: true,
  }),
  fixtureRun("a-medium", "2026-01-01T10:00:02.000Z", {
    batchId: "batch-a",
    batchIndex: 1,
  }),
];
const originalRuns = structuredClone(runs);
const groups = groupRunsForDisplay(runs);

assert.deepEqual(
  groups.map((group) => group.batchId || group.runs[0].runId),
  ["legacy-new", "batch-b", "batch-a", "legacy-old"],
);
assert.deepEqual(
  groups.find((group) => group.batchId === "batch-a").runs
    .map((run) => run.runId),
  ["a-low", "a-medium", "a-high"],
);
assert.deepEqual(
  groups.find((group) => group.batchId === "batch-b").runs
    .map((run) => run.runId),
  ["b-low", "b-medium"],
);
assert.equal(
  groups.filter((group) => group.batchId == null).length,
  2,
);
assert.deepEqual(runs, originalRuns);

const fallbackMembers = groupRunsForDisplay([
  fixtureRun("missing-late", "2026-01-01T11:00:04.000Z", {
    batchId: "batch-fallback",
  }),
  fixtureRun("duplicate-late", "2026-01-01T11:00:03.000Z", {
    batchId: "batch-fallback",
    batchIndex: 1,
  }),
  fixtureRun("duplicate-early", "2026-01-01T11:00:02.000Z", {
    batchId: "batch-fallback",
    batchIndex: 1,
  }),
]).at(0).runs;

assert.deepEqual(
  fallbackMembers.map((run) => run.runId),
  ["duplicate-early", "duplicate-late", "missing-late"],
);
assert.deepEqual(groupRunsForDisplay(null), []);

console.log("dashboard run grouping checks passed");

function fixtureRun(runId, createdAt, {
  batchId = null,
  batchIndex = null,
  topLevel = false,
} = {}) {
  return {
    runId,
    timestamps: { createdAt },
    ...(batchId
      ? topLevel
        ? { batchId, batchIndex }
        : { metrics: { batchId, batchIndex } }
      : {}),
  };
}
