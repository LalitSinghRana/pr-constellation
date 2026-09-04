import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_RETENTION_AFTER_CLOSE_MS,
  ANALYSIS_RETENTION_IDLE_MS,
  ANALYSIS_RETENTION_TERMINAL_RUN_MS,
  shouldDeleteTerminalRun,
  shouldExpireAnalysis,
} from "../../shared/analysis-retention.js";

const now = new Date("2026-08-20T12:00:00.000Z");

test("keeps a recently merged pull request until the close retention elapses", () => {
  assert.equal(
    shouldExpireAnalysis({
      item: {
        mergedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000).toISOString(),
        state: "MERGED",
        updatedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000).toISOString(),
      },
      now,
    }),
    false,
  );
});

test("deletes analysis seven days after merge or close", () => {
  assert.equal(
    shouldExpireAnalysis({
      item: {
        mergedAt: new Date(now.getTime() - ANALYSIS_RETENTION_AFTER_CLOSE_MS).toISOString(),
        state: "MERGED",
        updatedAt: new Date(now.getTime() - ANALYSIS_RETENTION_AFTER_CLOSE_MS).toISOString(),
      },
      now,
    }),
    true,
  );
  assert.equal(
    shouldExpireAnalysis({
      item: {
        closedAt: new Date(now.getTime() - ANALYSIS_RETENTION_AFTER_CLOSE_MS).toISOString(),
        state: "CLOSED",
        updatedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1_000).toISOString(),
      },
      now,
    }),
    true,
  );
});

test("does not delete an open pull request only because it is done", () => {
  assert.equal(
    shouldExpireAnalysis({
      item: {
        done: true,
        state: "OPEN",
        updatedAt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1_000).toISOString(),
      },
      now,
    }),
    false,
  );
});

test("deletes analysis seven days after it was marked done", () => {
  assert.equal(
    shouldExpireAnalysis({
      item: {
        done: true,
        doneAt: new Date(now.getTime() - ANALYSIS_RETENTION_AFTER_CLOSE_MS).toISOString(),
        state: "OPEN",
        updatedAt: now.toISOString(),
      },
      now,
    }),
    true,
  );
  assert.equal(
    shouldExpireAnalysis({
      item: {
        done: true,
        doneAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000).toISOString(),
        state: "OPEN",
        updatedAt: now.toISOString(),
      },
      now,
    }),
    false,
  );
});

test("deletes analysis after three months without GitHub activity", () => {
  assert.equal(
    shouldExpireAnalysis({
      item: {
        state: "OPEN",
        updatedAt: new Date(now.getTime() - ANALYSIS_RETENTION_IDLE_MS).toISOString(),
      },
      now,
    }),
    true,
  );
});

test("uses the latest run timestamp when the PR is not in the inbox", () => {
  assert.equal(
    shouldExpireAnalysis({
      latestRun: {
        timestamps: {
          updatedAt: new Date(now.getTime() - ANALYSIS_RETENTION_IDLE_MS).toISOString(),
        },
      },
      now,
    }),
    true,
  );
  assert.equal(
    shouldExpireAnalysis({
      latestRun: {
        timestamps: { updatedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000).toISOString() },
      },
      now,
    }),
    false,
  );
});

test("deletes failed analysis after two days and keeps the latest success for an active PR", () => {
  const twoDaysAgo = new Date(now.getTime() - ANALYSIS_RETENTION_TERMINAL_RUN_MS).toISOString();
  const active = { done: false, state: "OPEN", updatedAt: now.toISOString() };
  assert.equal(
    shouldDeleteTerminalRun({
      item: active,
      latestSucceededRunId: "run-ok",
      now,
      run: { runId: "run-fail", status: "failed", timestamps: { completedAt: twoDaysAgo } },
    }),
    true,
  );
  assert.equal(
    shouldDeleteTerminalRun({
      item: active,
      latestSucceededRunId: "run-ok",
      now,
      run: { runId: "run-ok", status: "succeeded", timestamps: { completedAt: twoDaysAgo } },
    }),
    false,
  );
  assert.equal(
    shouldDeleteTerminalRun({
      item: active,
      latestSucceededRunId: "run-ok",
      now,
      run: { runId: "run-old", status: "succeeded", timestamps: { completedAt: twoDaysAgo } },
    }),
    true,
  );
});

test("deletes a two-day-old success once the inbox row is no longer active", () => {
  const twoDaysAgo = new Date(now.getTime() - ANALYSIS_RETENTION_TERMINAL_RUN_MS).toISOString();
  assert.equal(
    shouldDeleteTerminalRun({
      item: {
        done: true,
        doneAt: now.toISOString(),
        state: "OPEN",
        updatedAt: now.toISOString(),
      },
      latestSucceededRunId: "run-ok",
      now,
      run: { runId: "run-ok", status: "succeeded", timestamps: { completedAt: twoDaysAgo } },
    }),
    true,
  );
});
