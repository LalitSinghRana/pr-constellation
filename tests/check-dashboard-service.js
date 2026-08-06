import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDashboardApiMiddleware } from "../cli/dashboard-api.js";
import {
  createInputFingerprint,
  DashboardService,
  loadDashboardConfiguration,
} from "../cli/dashboard-service.js";
import { publishStableReview } from "../cli/review-run.js";
import { RunStore } from "../cli/run-store.js";
import { parseGitHubPrUrl } from "../workflows/pr-review-analysis/02-fetch-pr/github.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pr-dashboard-service-"));
const reviewsDir = path.join(temporaryRoot, ".reviews");
const executions = [];
let activeExecutions = 0;
let maximumActiveExecutions = 0;
let freshAlphaVersion = 0;
let releaseFirstExecution;
let reportFirstExecutionStarted;
let codeVersionReads = 0;
let currentCodeVersion = {
  commit: "abc123",
  dirty: true,
  fingerprint: "abc123-dirty-fixture",
};
const firstExecutionGate = new Promise((resolve) => {
  releaseFirstExecution = resolve;
});
const firstExecutionStarted = new Promise((resolve) => {
  reportFirstExecutionStarted = resolve;
});

assert.equal(
  createInputFingerprint({
    diff: "same diff\n",
    metadata: { nested: { z: 3, a: 1 }, title: "Fixture" },
  }),
  createInputFingerprint({
    diff: "same diff\n",
    metadata: { title: "Fixture", nested: { a: 1, z: 3 } },
  }),
);
assert.notEqual(
  createInputFingerprint({ diff: "first diff\n", metadata: { title: "Fixture" } }),
  createInputFingerprint({ diff: "second diff\n", metadata: { title: "Fixture" } }),
);

try {
  const fixtureHome = path.join(temporaryRoot, "home");
  const fixtureCodexHome = path.join(fixtureHome, ".codex");
  const fixtureClaudeHome = path.join(fixtureHome, ".claude");
  await Promise.all([
    mkdir(fixtureCodexHome, { recursive: true }),
    mkdir(fixtureClaudeHome, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(fixtureCodexHome, "config.toml"),
      'model = "gpt-visible-a"\nmodel_reasoning_effort = "high"\n',
      "utf8",
    ),
    writeFile(
      path.join(fixtureCodexHome, "models_cache.json"),
      `${JSON.stringify({
        models: [
          {
            slug: "gpt-visible-a",
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "medium" },
              { effort: "high" },
              { effort: "xhigh" },
            ],
          },
          {
            slug: "gpt-visible-b",
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "high" },
            ],
          },
          {
            slug: "gpt-hidden",
            visibility: "hide",
            supported_reasoning_levels: [{ effort: "low" }],
          },
        ],
      })}\n`,
      "utf8",
    ),
    writeFile(
      path.join(fixtureClaudeHome, "settings.json"),
      // A moving personal alias must not silently change the pinned benchmark.
      `${JSON.stringify({ model: "opus[1m]" })}\n`,
      "utf8",
    ),
  ]);
  assert.deepEqual(
    await loadDashboardConfiguration({
      env: {},
      homeDir: fixtureHome,
      isClaudeAvailable: async () => false,
    }),
    {
      defaultModel: "gpt-visible-a",
      models: ["gpt-visible-a", "gpt-visible-b"],
      modelProviders: {
        "gpt-visible-a": "codex",
        "gpt-visible-b": "codex",
      },
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      modelReasoningEfforts: {
        "gpt-visible-a": ["low", "medium", "high", "xhigh"],
        "gpt-visible-b": ["low", "high"],
      },
    },
  );
  assert.deepEqual(
    await loadDashboardConfiguration({
      env: {},
      homeDir: fixtureHome,
      isClaudeAvailable: async () => true,
    }),
    {
      defaultModel: "gpt-visible-a",
      models: [
        "gpt-visible-a",
        "gpt-visible-b",
        "claude-opus-4-6[1m]",
      ],
      modelProviders: {
        "gpt-visible-a": "codex",
        "gpt-visible-b": "codex",
        "claude-opus-4-6[1m]": "claude",
      },
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      modelReasoningEfforts: {
        "gpt-visible-a": ["low", "medium", "high", "xhigh"],
        "gpt-visible-b": ["low", "high"],
        "claude-opus-4-6[1m]": ["low", "medium", "high", "max"],
      },
    },
  );

  const service = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture", "gpt-other", "claude-sonnet-4-6"],
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
    },
    getCodeVersion: async () => {
      codeVersionReads += 1;
      return { ...currentCodeVersion };
    },
    projectRoot: temporaryRoot,
    reviewsDir,
    runExecutor: async ({
      model,
      onEvent,
      prUrl,
      provider,
      reasoningEffort,
      runDir,
      sourceRunDir,
    }) => {
      activeExecutions += 1;
      maximumActiveExecutions = Math.max(
        maximumActiveExecutions,
        activeExecutions,
      );
      executions.push({
        model,
        prUrl,
        provider,
        reasoningEffort,
        runDir,
        sourceRunDir,
      });

      try {
        if (executions.length === 1) {
          reportFirstExecutionStarted();
          await firstExecutionGate;
        }
        await onEvent({
          at: new Date().toISOString(),
          label: "Fixture work",
          stageId: "fixture.work",
          type: "stage-start",
        });
        await new Promise((resolve) => setTimeout(resolve, 8));

        const parsed = parseFixturePrUrl(prUrl);
        const metadata = {
          additions: 8,
          baseRefOid: "base-sha",
          changedFiles: 2,
          deletions: 3,
          headRefOid: "head-sha",
          number: parsed.number,
          title: `Fixture PR ${parsed.number}`,
          url: prUrl,
        };
        let diff;
        if (sourceRunDir) {
          diff = await readFile(path.join(sourceRunDir, "diff.patch"), "utf8");
        } else if (parsed.number === 1) {
          freshAlphaVersion += 1;
          diff = `diff --git a/a.js b/a.js\nfresh alpha ${freshAlphaVersion}\n`;
        } else {
          diff = "diff --git a/a.js b/a.js\nfresh beta 1\n";
        }
        await mkdir(runDir, { recursive: true });
        await Promise.all([
          writeFile(
            path.join(runDir, "metadata.json"),
            `${JSON.stringify(metadata)}\n`,
            "utf8",
          ),
          writeFile(
            path.join(runDir, "diff.patch"),
            diff,
            "utf8",
          ),
          writeFile(
            path.join(runDir, "diff-inventory.json"),
            `${JSON.stringify({ schemaVersion: "diff-inventory/v1" })}\n`,
            "utf8",
          ),
          writeFile(
            path.join(runDir, "diff-summary.json"),
            `${JSON.stringify({ schemaVersion: "diff-summary/v1" })}\n`,
            "utf8",
          ),
          writeFile(path.join(runDir, "index.html"), "<p>fixture</p>", "utf8"),
        ]);
        await onEvent({
          at: new Date().toISOString(),
          label: "Fixture work",
          metrics: { elapsedMs: 8 },
          stageId: "fixture.work",
          status: "completed",
          type: "stage-finish",
        });

        return {
          diffSummary: {
            changedLineCount: 11,
            files: [{}, {}],
          },
          metadata,
          usage: {
            cachedInputTokens: 30,
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
          },
        };
      } finally {
        activeExecutions -= 1;
      }
    },
  });
  await service.initialize();

  const first = await service.enqueue({
    prUrl: "https://github.com/example/alpha/pull/1",
  });
  await firstExecutionStarted;
  const second = await service.enqueue({
    prUrl: "https://github.com/example/beta/pull/2",
    title: "Beta queued title",
  });
  assert.equal(second.title, "Beta queued title");
  currentCodeVersion = {
    commit: "def456",
    dirty: false,
    fingerprint: "def456",
  };
  releaseFirstExecution();
  await service.waitForIdle();

  assert.equal(maximumActiveExecutions, 1);
  assert.equal(executions.length, 2);
  assert.equal(executions[0].sourceRunDir, null);
  assert.equal(executions[1].sourceRunDir, null);
  assert.equal(executions[0].model, "gpt-fixture");
  assert.equal(executions[0].provider, "codex");
  assert.equal(executions[0].reasoningEffort, "xhigh");
  const storedFirst = await service.store.readRun(first.slug, first.runId);
  const storedSecond = await service.store.readRun(second.slug, second.runId);
  assert.equal(storedFirst.status, "succeeded");
  assert.equal(storedSecond.status, "succeeded");
  assert.equal(storedFirst.gitCommit, "abc123");
  assert.equal(storedFirst.metrics.codeFingerprint, "abc123-dirty-fixture");
  assert.deepEqual(storedFirst.metrics.usage, {
    cachedInputTokens: 30,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
  });
  assert.deepEqual(storedFirst.metrics.tokens, storedFirst.metrics.usage);
  assert.equal(storedSecond.gitCommit, "def456");
  assert.equal(storedSecond.metrics.codeFingerprint, "def456");
  assert.match(storedFirst.metrics.inputFingerprint, /^[a-f0-9]{64}$/);

  const frozen = await service.enqueue({
    prUrl: "https://github.com/example/alpha/pull/1",
  });
  assert.equal(frozen.sourceMode, "frozen");
  assert.equal(frozen.sourceRunId, first.runId);
  assert.equal(
    frozen.metrics.inputFingerprint,
    storedFirst.metrics.inputFingerprint,
  );
  await service.waitForIdle();
  assert.equal(
    executions.at(-1).sourceRunDir,
    await realpath(service.store.getRunDir(first.slug, first.runId)),
  );
  const storedFrozen = await service.store.readRun(frozen.slug, frozen.runId);
  assert.equal(
    storedFrozen.metrics.inputFingerprint,
    storedFirst.metrics.inputFingerprint,
  );

  const refreshed = await service.enqueue({
    prUrl: "https://github.com/example/alpha/pull/1",
    refresh: true,
  });
  assert.equal(refreshed.sourceMode, "fresh");
  assert.equal(refreshed.sourceRunId, null);
  await service.waitForIdle();
  assert.equal(executions.at(-1).sourceRunDir, null);
  const storedRefreshed = await service.store.readRun(
    refreshed.slug,
    refreshed.runId,
  );
  assert.notEqual(
    storedRefreshed.metrics.inputFingerprint,
    storedFirst.metrics.inputFingerprint,
  );
  assert.equal(codeVersionReads, executions.length);

  const dashboard = await service.snapshot();
  assert.equal(dashboard.prs.length, 2);
  assert.equal(dashboard.pullRequests, dashboard.prs);
  assert.equal(dashboard.queue.activeRunId, null);
  assert.deepEqual(dashboard.queue.queuedRunIds, []);
  const alpha = dashboard.prs.find((pr) => pr.slug === first.slug);
  assert.equal(alpha.runs.length, 3);
  assert.equal(alpha.runs[0].currentStage, "Complete");
  assert.equal(alpha.runs[0].metrics.codeFingerprint, "def456");
  assert.equal(
    alpha.runs[0].timings.stages.find((stage) => stage.stageId === "run.total").status,
    "completed",
  );
  assert.equal(
    alpha.runs[0].timings.stages.find((stage) => stage.stageId === "fixture.work").parentStageId,
    "run.total",
  );

  const batch = await service.enqueueBatch({
    model: "gpt-other",
    prUrl: "https://github.com/example/gamma/pull/3",
    refresh: true,
  });
  assert.equal(batch.model, "gpt-other");
  assert.deepEqual(batch.reasoningEfforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(batch.runs.length, 4);
  assert.equal(batch.runs[0].sourceMode, "fresh");
  assert.equal(batch.runs[0].sourceRunId, null);
  assert.deepEqual(
    batch.runs.slice(1).map((run) => run.sourceRunId),
    Array(3).fill(batch.runs[0].runId),
  );
  assert.deepEqual(
    batch.runs.map((run) => run.metrics.reasoningEffort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(
    new Set(batch.runs.map((run) => run.metrics.batchId)).size,
    1,
  );
  await service.waitForIdle();

  const batchExecutions = executions.slice(-4);
  assert.deepEqual(
    batchExecutions.map((execution) => execution.reasoningEffort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    batchExecutions.map((execution) => execution.model),
    Array(4).fill("gpt-other"),
  );
  assert.equal(batchExecutions[0].sourceRunDir, null);
  const firstBatchRunDir = await realpath(
    service.store.getRunDir(batch.runs[0].slug, batch.runs[0].runId),
  );
  assert.deepEqual(
    batchExecutions.slice(1).map((execution) => execution.sourceRunDir),
    Array(3).fill(firstBatchRunDir),
  );
  const storedBatchRuns = await Promise.all(
    batch.runs.map((run) => service.store.readRun(run.slug, run.runId)),
  );
  assert.deepEqual(
    storedBatchRuns.map((run) => run.status),
    Array(4).fill("succeeded"),
  );
  assert.equal(
    new Set(storedBatchRuns.map((run) => run.metrics.inputFingerprint)).size,
    1,
  );
  const snapshotAfterBatch = await service.snapshot();
  assert.deepEqual(snapshotAfterBatch.configuration, {
    defaultModel: "gpt-fixture",
    models: ["gpt-fixture", "gpt-other", "claude-sonnet-4-6"],
    modelProviders: {
      "gpt-fixture": "codex",
      "gpt-other": "codex",
      "claude-sonnet-4-6": "claude",
    },
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    modelReasoningEfforts: {
      "gpt-fixture": ["low", "medium", "high", "xhigh"],
      "gpt-other": ["low", "medium", "high", "xhigh"],
      "claude-sonnet-4-6": ["low", "medium", "high", "max"],
    },
  });

  const claudeBatch = await service.enqueueBatch({
    model: "claude-sonnet-4-6",
    prUrl: "https://github.com/example/claude/pull/4",
    refresh: true,
  });
  assert.equal(claudeBatch.provider, "claude");
  assert.deepEqual(
    claudeBatch.reasoningEfforts,
    ["low", "medium", "high", "max"],
  );
  assert.deepEqual(
    claudeBatch.runs.map((run) => run.metrics.provider),
    Array(4).fill("claude"),
  );
  await service.waitForIdle();
  const claudeExecutions = executions.slice(-4);
  assert.deepEqual(
    claudeExecutions.map((execution) => execution.provider),
    Array(4).fill("claude"),
  );
  assert.deepEqual(
    claudeExecutions.map((execution) => execution.reasoningEffort),
    ["low", "medium", "high", "max"],
  );
  const storedClaudeRuns = await Promise.all(
    claudeBatch.runs.map((run) => service.store.readRun(run.slug, run.runId)),
  );
  assert.deepEqual(
    storedClaudeRuns.map((run) => run.metrics.provider),
    Array(4).fill("claude"),
  );

  await assert.rejects(
    () => service.enqueueBatch({
      model: "gpt-unknown",
      prUrl: "https://github.com/example/gamma/pull/3",
    }),
    { code: "INVALID_MODEL" },
  );
  await assert.rejects(
    () => service.enqueue({
      model: "gpt-other",
      prUrl: "https://github.com/example/gamma/pull/3",
      reasoningEffort: "max",
    }),
    { code: "INVALID_REASONING_EFFORT" },
  );
  await assert.rejects(
    () => service.enqueue({
      model: "claude-sonnet-4-6",
      prUrl: "https://github.com/example/claude/pull/4",
      reasoningEffort: "xhigh",
    }),
    { code: "INVALID_REASONING_EFFORT" },
  );

  const rerunRun = await service.enqueueFrozenRerun({
    model: "gpt-other",
    runId: first.runId,
    slug: first.slug,
  });
  assert.equal(rerunRun.metrics.model, "gpt-other");
  assert.equal(rerunRun.sourceRunId, first.runId);
  await service.waitForIdle();
  assert.equal(
    executions.at(-1).sourceRunDir,
    await realpath(service.store.getRunDir(first.slug, first.runId)),
  );

  const batchRerun = await service.enqueueFrozenBatchRerun({
    batchId: batch.batchId,
    model: "gpt-fixture",
  });
  assert.equal(batchRerun.metrics.model, "gpt-fixture");
  await assert.rejects(
    () => service.deleteRunHistory({
      runId: batchRerun.runId,
      slug: batchRerun.slug,
    }),
    { code: "HISTORY_TARGET_ACTIVE" },
  );
  await service.waitForIdle();

  const deletedRun = await service.deleteRunHistory({
    runId: frozen.runId,
    slug: frozen.slug,
  });
  assert.equal(deletedRun.deletedRunCount, 1);
  await assert.rejects(
    () => service.store.readRun(frozen.slug, frozen.runId),
    { code: "ENOENT" },
  );

  const deletedBatch = await service.deleteBatchHistory({
    batchId: claudeBatch.batchId,
  });
  assert.equal(deletedBatch.deletedRunCount, 4);
  assert.deepEqual(
    deletedBatch.deletedRunIds.sort(),
    claudeBatch.runs.map((run) => run.runId).sort(),
  );
  await assert.rejects(
    () => service.deleteBatchHistory({ batchId: claudeBatch.batchId }),
    { code: "HISTORY_TARGET_NOT_FOUND" },
  );
  assert.equal(maximumActiveExecutions, 1);

  const failingService = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      reasoningEfforts: ["low"],
    },
    getCodeVersion: async () => ({ ...currentCodeVersion }),
    projectRoot: temporaryRoot,
    reviewsDir: path.join(temporaryRoot, ".failed-reviews"),
    runExecutor: async () => {
      throw Object.assign(new Error("fixture failure"), {
        usage: {
          cachedInputTokens: 25,
          inputTokens: 80,
          outputTokens: 15,
          totalTokens: 95,
        },
      });
    },
  });
  await failingService.initialize();
  const failed = await failingService.enqueue({
    prUrl: "https://github.com/example/failure/pull/4",
  });
  await failingService.waitForIdle();
  const storedFailed = await failingService.store.readRun(
    failed.slug,
    failed.runId,
  );
  assert.equal(storedFailed.status, "failed");
  assert.deepEqual(storedFailed.metrics.usage, {
    cachedInputTokens: 25,
    inputTokens: 80,
    outputTokens: 15,
    totalTokens: 95,
  });
  assert.deepEqual(storedFailed.metrics.tokens, storedFailed.metrics.usage);
  failingService.close();

  service.close();
  await checkCancellation();
  await checkCancellationCommitRace();
  await checkSuccessPublicationWinsCancellation();
  await checkApiMiddleware();
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

console.log("dashboard service checks passed");

async function checkCancellation() {
  const configuration = {
    defaultModel: "gpt-fixture",
    models: ["gpt-fixture"],
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  };
  const codeVersion = async () => ({
    commit: "cancel-fixture",
    dirty: false,
    fingerprint: "cancel-fixture",
  });

  let reportBatchStarted;
  const batchStarted = new Promise((resolve) => {
    reportBatchStarted = resolve;
  });
  const batchSignals = [];
  const batchService = new DashboardService({
    configuration,
    getCodeVersion: codeVersion,
    projectRoot: temporaryRoot,
    reviewsDir: path.join(temporaryRoot, ".cancel-batch-reviews"),
    runExecutor: createCancelableExecutor({
      onStarted: (context) => {
        batchSignals.push(context.signal);
        reportBatchStarted(context);
      },
    }),
  });
  await batchService.initialize();

  const batch = await batchService.enqueueBatch({
    prUrl: "https://github.com/example/cancel-batch/pull/10",
    refresh: true,
  });
  const activeBatchExecution = await batchStarted;
  assert.equal(activeBatchExecution.reasoningEffort, "low");
  assert.equal(activeBatchExecution.signal.aborted, false);
  await assert.rejects(
    () => batchService.deleteBatchHistory({ batchId: batch.batchId }),
    { code: "HISTORY_TARGET_ACTIVE" },
  );
  await assert.rejects(
    () => batchService.deleteRunHistory({
      runId: batch.runs[0].runId,
      slug: batch.runs[0].slug,
    }),
    { code: "HISTORY_TARGET_ACTIVE" },
  );

  const batchCancellation = await batchService.cancelBatch({
    batchId: batch.batchId,
  });
  assert.equal(batchCancellation.canceled, true);
  assert.equal(batchCancellation.activeRunId, batch.runs[0].runId);
  assert.deepEqual(
    batchCancellation.queuedRunIds,
    batch.runs.slice(1).map((run) => run.runId),
  );
  assert.deepEqual(
    new Set(batchCancellation.canceledRunIds),
    new Set(batch.runs.map((run) => run.runId)),
  );
  assert.equal(batchCancellation.canceledRunCount, 4);
  assert.equal(activeBatchExecution.signal.aborted, true);
  await batchService.waitForIdle();
  assert.equal(batchSignals.length, 1);

  const canceledBatchRuns = await Promise.all(
    batch.runs.map((run) => batchService.store.readRun(run.slug, run.runId)),
  );
  assert.deepEqual(
    canceledBatchRuns.map((run) => run.status),
    Array(4).fill("canceled"),
  );
  assert.deepEqual(
    canceledBatchRuns.map((run) => run.phase),
    Array(4).fill("Canceled"),
  );
  assert.ok(
    canceledBatchRuns.every((run) => run.error?.code === "RUN_CANCELED"),
  );
  assert.match(
    canceledBatchRuns[0].metrics.inputFingerprint,
    /^[a-f0-9]{64}$/,
  );
  const canceledBatchTimings = await batchService.store.readTimings(
    batch.runs[0].slug,
    batch.runs[0].runId,
  );
  assert.equal(
    canceledBatchTimings.stages.find(
      (stage) => stage.stageId === "fixture.cancelable",
    )?.status,
    "canceled",
  );
  assert.equal(
    canceledBatchTimings.stages.find(
      (stage) => stage.stageId === "run.total",
    )?.status,
    "canceled",
  );
  await assert.rejects(
    () => batchService.cancelBatch({ batchId: batch.batchId }),
    { code: "CANCEL_TARGET_NOT_FOUND" },
  );

  const delegatedBatch = await batchService.enqueueBatch({
    prUrl: "https://github.com/example/cancel-delegated/pull/13",
    refresh: true,
  });
  const delegatedCancellation = await batchService.cancelRun({
    runId: delegatedBatch.runs[2].runId,
    slug: delegatedBatch.runs[2].slug,
  });
  assert.equal(delegatedCancellation.delegatedToBatch, true);
  assert.equal(delegatedCancellation.requestedRunId, delegatedBatch.runs[2].runId);
  assert.equal(delegatedCancellation.batchId, delegatedBatch.batchId);
  assert.equal(delegatedCancellation.canceledRunCount, 4);
  await batchService.waitForIdle();
  const delegatedRuns = await Promise.all(
    delegatedBatch.runs.map((run) =>
      batchService.store.readRun(run.slug, run.runId),
    ),
  );
  assert.deepEqual(
    delegatedRuns.map((run) => run.status),
    Array(4).fill("canceled"),
  );
  batchService.close();

  let reportLegacyStarted;
  const legacyStarted = new Promise((resolve) => {
    reportLegacyStarted = resolve;
  });
  const legacyService = new DashboardService({
    configuration: {
      ...configuration,
      reasoningEfforts: ["low"],
    },
    getCodeVersion: codeVersion,
    projectRoot: temporaryRoot,
    reviewsDir: path.join(temporaryRoot, ".cancel-legacy-reviews"),
    runExecutor: createCancelableExecutor({
      onStarted: reportLegacyStarted,
    }),
  });
  await legacyService.initialize();
  const legacy = await legacyService.enqueue({
    prUrl: "https://github.com/example/cancel-legacy/pull/11",
    refresh: true,
  });
  const activeLegacyExecution = await legacyStarted;
  const legacyCancellation = await legacyService.cancelRun({
    runId: legacy.runId,
    slug: legacy.slug,
  });
  assert.equal(legacyCancellation.delegatedToBatch, false);
  assert.deepEqual(legacyCancellation.canceledRunIds, [legacy.runId]);
  assert.equal(activeLegacyExecution.signal.aborted, true);
  await legacyService.waitForIdle();
  const canceledLegacy = await legacyService.store.readRun(
    legacy.slug,
    legacy.runId,
  );
  assert.equal(canceledLegacy.status, "canceled");
  assert.equal(canceledLegacy.phase, "Canceled");
  assert.equal(canceledLegacy.error.code, "RUN_CANCELED");
  await assert.rejects(
    () => legacyService.cancelRun({
      runId: legacy.runId,
      slug: legacy.slug,
    }),
    { code: "CANCEL_TARGET_NOT_FOUND" },
  );
  legacyService.close();

  let reportCloseStarted;
  const closeStarted = new Promise((resolve) => {
    reportCloseStarted = resolve;
  });
  const closeService = new DashboardService({
    configuration: {
      ...configuration,
      reasoningEfforts: ["low"],
    },
    getCodeVersion: codeVersion,
    projectRoot: temporaryRoot,
    reviewsDir: path.join(temporaryRoot, ".close-cancel-reviews"),
    runExecutor: createCancelableExecutor({
      onStarted: reportCloseStarted,
    }),
  });
  await closeService.initialize();
  const closingRun = await closeService.enqueue({
    prUrl: "https://github.com/example/close-cancel/pull/12",
    refresh: true,
  });
  const closingExecution = await closeStarted;
  closeService.close();
  assert.equal(closingExecution.signal.aborted, true);
  await closeService.waitForIdle();
  const storedClosingRun = await closeService.store.readRun(
    closingRun.slug,
    closingRun.runId,
  );
  assert.equal(storedClosingRun.status, "canceled");
}

async function checkCancellationCommitRace() {
  const raceReviewsDir = path.join(temporaryRoot, ".cancel-race-reviews");
  const racePrUrl = "https://github.com/example/cancel-race/pull/14";
  const raceSlug = parseGitHubPrUrl(racePrUrl).slug;
  const stableHtmlPath = path.join(raceReviewsDir, raceSlug, "index.html");
  const previousStableHtml = "<p>previous successful race review</p>";
  await mkdir(path.dirname(stableHtmlPath), { recursive: true });
  await writeFile(stableHtmlPath, previousStableHtml, "utf8");
  const backingStore = new RunStore({ reviewsDir: raceReviewsDir });
  let releaseCompletedTiming;
  let reportCompletedTiming;
  let reportCanceledManifest;
  const completedTimingEntered = new Promise((resolve) => {
    reportCompletedTiming = resolve;
  });
  const canceledManifestWritten = new Promise((resolve) => {
    reportCanceledManifest = resolve;
  });
  const completedTimingGate = new Promise((resolve) => {
    releaseCompletedTiming = resolve;
  });
  const gatedStore = new Proxy(backingStore, {
    get(target, property) {
      if (property === "recordStageEvent") {
        return async (slug, runId, event) => {
          if (
            event.stageId === "run.total"
            && event.status === "completed"
          ) {
            reportCompletedTiming();
            await completedTimingGate;
          }
          return target.recordStageEvent(slug, runId, event);
        };
      }
      if (property === "updateRun") {
        return async (...args) => {
          const updated = await target.updateRun(...args);
          if (updated.status === "canceled") {
            reportCanceledManifest();
          }
          return updated;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      reasoningEfforts: ["low"],
    },
    getCodeVersion: async () => ({
      commit: "race-fixture",
      dirty: false,
      fingerprint: "race-fixture",
    }),
    projectRoot: temporaryRoot,
    reviewsDir: raceReviewsDir,
    runExecutor: async ({ onEvent, prUrl, runDir, signal }) => {
      assert.equal(signal.aborted, false);
      const parsed = parseFixturePrUrl(prUrl);
      const metadata = {
        additions: 1,
        baseRefOid: "race-base",
        changedFiles: 1,
        deletions: 0,
        headRefOid: "race-head",
        number: parsed.number,
        title: `Race PR ${parsed.number}`,
        url: prUrl,
      };
      await mkdir(runDir, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(runDir, "metadata.json"),
          `${JSON.stringify(metadata)}\n`,
          "utf8",
        ),
        writeFile(
          path.join(runDir, "diff.patch"),
          "diff --git a/race.js b/race.js\n+race fixture\n",
          "utf8",
        ),
        writeFile(
          path.join(runDir, "index.html"),
          "<p>canceled race review</p>",
          "utf8",
        ),
      ]);
      await onEvent({
        at: new Date().toISOString(),
        label: "Race fixture",
        stageId: "fixture.race",
        type: "stage-start",
      });
      await onEvent({
        at: new Date().toISOString(),
        label: "Race fixture",
        stageId: "fixture.race",
        status: "completed",
        type: "stage-finish",
      });
      return {
        diffSummary: {
          changedLineCount: 1,
          files: [{}],
        },
        htmlPath: path.join(runDir, "index.html"),
        metadata,
        stableHtmlPath,
      };
    },
    store: gatedStore,
  });
  await service.initialize();
  const batch = await service.enqueueBatch({
    prUrl: racePrUrl,
    refresh: true,
  });
  await completedTimingEntered;

  const cancellationPromise = service.cancelBatch({
    batchId: batch.batchId,
  });
  await canceledManifestWritten;
  releaseCompletedTiming();
  const cancellation = await cancellationPromise;
  assert.equal(cancellation.canceledRunCount, 1);
  const run = batch.runs[0];
  const immediatelyCanceled = await backingStore.readRun(run.slug, run.runId);
  const immediateTimings = await backingStore.readTimings(run.slug, run.runId);
  assert.equal(immediatelyCanceled.status, "canceled");
  assert.ok(
    immediateTimings.stages.every(
      (stage) => stage.endedAt && stage.status !== "running",
    ),
  );
  assert.equal(
    immediateTimings.stages.find((stage) => stage.stageId === "run.total")
      ?.status,
    "canceled",
  );
  assert.equal(await readFile(stableHtmlPath, "utf8"), previousStableHtml);
  assert.equal(
    await readFile(path.join(
      service.store.getRunDir(run.slug, run.runId),
      "index.html",
    ), "utf8"),
    "<p>canceled race review</p>",
  );

  const restartedService = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      reasoningEfforts: ["low"],
    },
    projectRoot: temporaryRoot,
    reviewsDir: raceReviewsDir,
    runExecutor: async () => {
      throw new Error("Restarted service must not execute canceled work.");
    },
  });
  await restartedService.initialize();
  const afterRestart = await restartedService.store.readTimings(
    run.slug,
    run.runId,
  );
  assert.ok(afterRestart.stages.every((stage) => stage.endedAt));
  restartedService.close();

  await service.waitForIdle();
  const finallyCanceled = await backingStore.readRun(run.slug, run.runId);
  const finalTimings = await backingStore.readTimings(run.slug, run.runId);
  assert.equal(finallyCanceled.status, "canceled");
  assert.equal(finallyCanceled.phase, "Canceled");
  assert.equal(
    finalTimings.stages.find((stage) => stage.stageId === "run.total")?.status,
    "canceled",
  );
  assert.ok(finalTimings.stages.every((stage) => stage.endedAt));
  assert.equal(await readFile(stableHtmlPath, "utf8"), previousStableHtml);
  service.close();
}

async function checkSuccessPublicationWinsCancellation() {
  const reviewsDir = path.join(temporaryRoot, ".success-publish-race-reviews");
  const prUrl = "https://github.com/example/success-publish-race/pull/15";
  const slug = parseGitHubPrUrl(prUrl).slug;
  const stableHtmlPath = path.join(reviewsDir, slug, "index.html");
  const previousStableHtml = "<p>previous successful review</p>";
  const promotedHtml = "<p>new successful review</p>";
  await mkdir(path.dirname(stableHtmlPath), { recursive: true });
  await writeFile(stableHtmlPath, previousStableHtml, "utf8");

  let releasePublication;
  let reportPublicationStarted;
  const publicationGate = new Promise((resolve) => {
    releasePublication = resolve;
  });
  const publicationStarted = new Promise((resolve) => {
    reportPublicationStarted = resolve;
  });
  const service = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      reasoningEfforts: ["low", "medium"],
    },
    getCodeVersion: async () => ({
      commit: "publish-race-fixture",
      dirty: false,
      fingerprint: "publish-race-fixture",
    }),
    projectRoot: temporaryRoot,
    publishReview: async (paths) => {
      reportPublicationStarted(paths);
      await publicationGate;
      await publishStableReview(paths);
    },
    reviewsDir,
    runExecutor: async ({ prUrl: executionUrl, runDir, signal }) => {
      assert.equal(signal.aborted, false);
      const parsed = parseFixturePrUrl(executionUrl);
      const metadata = {
        additions: 1,
        baseRefOid: "publish-base",
        changedFiles: 1,
        deletions: 0,
        headRefOid: "publish-head",
        number: parsed.number,
        title: `Publish PR ${parsed.number}`,
        url: executionUrl,
      };
      const htmlPath = path.join(runDir, "index.html");
      await mkdir(runDir, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(runDir, "metadata.json"),
          `${JSON.stringify(metadata)}\n`,
          "utf8",
        ),
        writeFile(
          path.join(runDir, "diff.patch"),
          "diff --git a/publish.js b/publish.js\n+publish fixture\n",
          "utf8",
        ),
        writeFile(htmlPath, promotedHtml, "utf8"),
      ]);
      return {
        diffSummary: {
          changedLineCount: 1,
          files: [{}],
        },
        htmlPath,
        metadata,
        stableHtmlPath,
      };
    },
  });
  await service.initialize();

  const batch = await service.enqueueBatch({
    prUrl,
    refresh: true,
  });
  const publicationPaths = await publicationStarted;
  assert.equal(
    publicationPaths.htmlPath,
    path.join(
      service.store.getRunDir(batch.runs[0].slug, batch.runs[0].runId),
      "index.html",
    ),
  );
  const committedBeforePublication = await service.store.readRun(
    batch.runs[0].slug,
    batch.runs[0].runId,
  );
  assert.equal(committedBeforePublication.status, "succeeded");
  assert.equal(await readFile(stableHtmlPath, "utf8"), previousStableHtml);

  const cancellation = await service.cancelBatch({
    batchId: batch.batchId,
  });
  assert.deepEqual(cancellation.canceledRunIds, [batch.runs[1].runId]);
  assert.equal(cancellation.canceledRunCount, 1);

  releasePublication();
  await service.waitForIdle();

  const [successfulRun, canceledSibling] = await Promise.all(
    batch.runs.map((run) => service.store.readRun(run.slug, run.runId)),
  );
  assert.equal(successfulRun.status, "succeeded");
  assert.equal(canceledSibling.status, "canceled");
  const successfulTimings = await service.store.readTimings(
    successfulRun.slug,
    successfulRun.runId,
  );
  assert.equal(
    successfulTimings.stages.find(
      (stage) => stage.stageId === "run.total",
    )?.status,
    "completed",
  );
  assert.equal(await readFile(stableHtmlPath, "utf8"), promotedHtml);
  service.close();

  const failedPublicationHtml = "<p>failed publication review</p>";
  const failedPublicationService = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      reasoningEfforts: ["low"],
    },
    getCodeVersion: async () => ({
      commit: "failed-publish-fixture",
      dirty: false,
      fingerprint: "failed-publish-fixture",
    }),
    projectRoot: temporaryRoot,
    publishReview: async () => {
      throw new Error("Fixture publication failed before atomic rename.");
    },
    reviewsDir,
    runExecutor: async ({ prUrl: executionUrl, runDir }) => {
      const parsed = parseFixturePrUrl(executionUrl);
      const metadata = {
        additions: 1,
        baseRefOid: "failed-publish-base",
        changedFiles: 1,
        deletions: 0,
        headRefOid: "failed-publish-head",
        number: parsed.number,
        title: `Failed publish PR ${parsed.number}`,
        url: executionUrl,
      };
      const htmlPath = path.join(runDir, "index.html");
      await mkdir(runDir, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(runDir, "metadata.json"),
          `${JSON.stringify(metadata)}\n`,
          "utf8",
        ),
        writeFile(
          path.join(runDir, "diff.patch"),
          "diff --git a/failed.js b/failed.js\n+failed publish fixture\n",
          "utf8",
        ),
        writeFile(htmlPath, failedPublicationHtml, "utf8"),
      ]);
      return {
        diffSummary: {
          changedLineCount: 1,
          files: [{}],
        },
        htmlPath,
        metadata,
        stableHtmlPath,
      };
    },
  });
  await failedPublicationService.initialize();
  const failedPublicationRun = await failedPublicationService.enqueue({
    prUrl,
    refresh: true,
  });
  await failedPublicationService.waitForIdle();
  const storedFailedPublication = await failedPublicationService.store.readRun(
    failedPublicationRun.slug,
    failedPublicationRun.runId,
  );
  assert.equal(storedFailedPublication.status, "failed");
  assert.equal(storedFailedPublication.error.code, "RUN_FAILED");
  assert.equal(await readFile(stableHtmlPath, "utf8"), promotedHtml);
  assert.equal(
    await readFile(path.join(
      failedPublicationService.store.getRunDir(
        failedPublicationRun.slug,
        failedPublicationRun.runId,
      ),
      "index.html",
    ), "utf8"),
    failedPublicationHtml,
  );
  failedPublicationService.close();
}

async function checkApiMiddleware() {
  const calls = [];
  const fakeService = {
    cancelBatch: async (input) => {
      calls.push(["cancelBatch", input]);
      return {
        batchId: input.batchId,
        canceled: true,
        canceledRunCount: 4,
      };
    },
    cancelRun: async (input) => {
      calls.push(["cancelRun", input]);
      if (input.runId === "inactive-run") {
        const error = new Error("Run is not active.");
        error.code = "CANCEL_TARGET_NOT_FOUND";
        throw error;
      }
      return {
        batchId: null,
        canceled: true,
        canceledRunCount: 1,
        requestedRunId: input.runId,
        requestedSlug: input.slug,
      };
    },
    deleteBatchHistory: async (input) => {
      calls.push(["deleteBatch", input]);
      return {
        batchId: input.batchId,
        deleted: true,
        deletedRunCount: 4,
      };
    },
    deleteRunHistory: async (input) => {
      calls.push(["deleteRun", input]);
      return {
        batchId: null,
        deleted: true,
        deletedRunCount: 1,
        slug: input.slug,
      };
    },
    enqueue: async (input) => {
      calls.push(["enqueue", input]);
      return {
        metrics: { model: input.model, reasoningEffort: "xhigh" },
        runId: "new-run",
      };
    },
    enqueueFrozenRerun: async (input) => {
      calls.push(["rerun", input]);
      return {
        metrics: { model: input.model, reasoningEffort: "xhigh" },
        runId: "rerun",
      };
    },
    enqueueFrozenBatchRerun: async (input) => {
      calls.push(["rerunBatch", input]);
      return {
        metrics: { model: input.model, reasoningEffort: "xhigh" },
        runId: "next-run",
      };
    },
    snapshot: async () => ({ prs: [], queue: {} }),
  };
  const middleware = createDashboardApiMiddleware({ service: fakeService });
  const server = createServer((request, response) => {
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(dashboardResponse.status, 200);
    assert.deepEqual(await dashboardResponse.json(), { prs: [], queue: {} });

    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      body: JSON.stringify({
        model: "gpt-fixture",
        prUrl: "https://github.com/example/alpha/pull/1",
        refresh: true,
        title: "Alpha pull request",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(createResponse.status, 202);
    assert.deepEqual(await createResponse.json(), {
      run: {
        metrics: { model: "gpt-fixture", reasoningEffort: "xhigh" },
        runId: "new-run",
      },
      runs: [{
        metrics: { model: "gpt-fixture", reasoningEffort: "xhigh" },
        runId: "new-run",
      }],
    });
    assert.deepEqual(calls[0], [
      "enqueue",
      {
        model: "gpt-fixture",
        prUrl: "https://github.com/example/alpha/pull/1",
        refresh: true,
        title: "Alpha pull request",
      },
    ]);

    const rerunResponse = await fetch(
      `${baseUrl}/api/runs/alpha-1/source-run/rerun`,
      {
        body: JSON.stringify({ model: "gpt-other" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    assert.equal(rerunResponse.status, 202);
    assert.deepEqual(calls[1], [
      "rerun",
      { model: "gpt-other", runId: "source-run", slug: "alpha-1" },
    ]);

    const rerunBatchResponse = await fetch(
      `${baseUrl}/api/batches/source-batch/rerun`,
      {
        body: JSON.stringify({ model: "gpt-other" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    assert.equal(rerunBatchResponse.status, 202);
    assert.deepEqual(calls[2], [
      "rerunBatch",
      { batchId: "source-batch", model: "gpt-other" },
    ]);

    const cancelBatchResponse = await fetch(
      `${baseUrl}/api/batches/batch-to-cancel/cancel`,
      { method: "POST" },
    );
    assert.equal(cancelBatchResponse.status, 200);
    assert.deepEqual(await cancelBatchResponse.json(), {
      cancellation: {
        batchId: "batch-to-cancel",
        canceled: true,
        canceledRunCount: 4,
      },
    });
    assert.deepEqual(calls[3], [
      "cancelBatch",
      { batchId: "batch-to-cancel" },
    ]);

    const cancelRunResponse = await fetch(
      `${baseUrl}/api/runs/alpha-1/run-to-cancel/cancel`,
      { method: "POST" },
    );
    assert.equal(cancelRunResponse.status, 200);
    assert.deepEqual(await cancelRunResponse.json(), {
      cancellation: {
        batchId: null,
        canceled: true,
        canceledRunCount: 1,
        requestedRunId: "run-to-cancel",
        requestedSlug: "alpha-1",
      },
    });
    assert.deepEqual(calls[4], [
      "cancelRun",
      { runId: "run-to-cancel", slug: "alpha-1" },
    ]);

    const deleteRunResponse = await fetch(
      `${baseUrl}/api/runs/alpha-1/run-to-delete`,
      { method: "DELETE" },
    );
    assert.equal(deleteRunResponse.status, 200);
    assert.deepEqual(await deleteRunResponse.json(), {
      deletion: {
        batchId: null,
        deleted: true,
        deletedRunCount: 1,
        slug: "alpha-1",
      },
    });
    assert.deepEqual(calls[5], [
      "deleteRun",
      { runId: "run-to-delete", slug: "alpha-1" },
    ]);

    const deleteBatchResponse = await fetch(
      `${baseUrl}/api/batches/batch-to-delete`,
      { method: "DELETE" },
    );
    assert.equal(deleteBatchResponse.status, 200);
    assert.deepEqual(await deleteBatchResponse.json(), {
      deletion: {
        batchId: "batch-to-delete",
        deleted: true,
        deletedRunCount: 4,
      },
    });
    assert.deepEqual(calls[6], [
      "deleteBatch",
      { batchId: "batch-to-delete" },
    ]);

    const inactiveCancelResponse = await fetch(
      `${baseUrl}/api/runs/alpha-1/inactive-run/cancel`,
      { method: "POST" },
    );
    assert.equal(inactiveCancelResponse.status, 404);
    assert.deepEqual(await inactiveCancelResponse.json(), {
      error: "Run is not active.",
    });

    const invalidResponse = await fetch(`${baseUrl}/api/runs`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(invalidResponse.status, 400);

    const invalidModelResponse = await fetch(`${baseUrl}/api/runs`, {
      body: JSON.stringify({
        model: 55,
        prUrl: "https://github.com/example/alpha/pull/1",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(invalidModelResponse.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createCancelableExecutor({ onStarted }) {
  return async function cancelableExecutor({
    onEvent,
    prUrl,
    reasoningEffort,
    runDir,
    signal,
  }) {
    assert.equal(typeof signal?.aborted, "boolean");
    const parsed = parseFixturePrUrl(prUrl);
    const metadata = {
      additions: 1,
      baseRefOid: "cancel-base",
      changedFiles: 1,
      deletions: 0,
      headRefOid: "cancel-head",
      number: parsed.number,
      title: `Cancelable PR ${parsed.number}`,
      url: prUrl,
    };
    await mkdir(runDir, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(runDir, "metadata.json"),
        `${JSON.stringify(metadata)}\n`,
        "utf8",
      ),
      writeFile(
        path.join(runDir, "diff.patch"),
        "diff --git a/a.js b/a.js\n+cancel fixture\n",
        "utf8",
      ),
    ]);
    await onEvent({
      at: new Date().toISOString(),
      label: "Cancelable fixture",
      stageId: "fixture.cancelable",
      type: "stage-start",
    });
    onStarted({ reasoningEffort, signal });

    try {
      await new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      });
    } catch (error) {
      await onEvent({
        at: new Date().toISOString(),
        error,
        label: "Cancelable fixture",
        stageId: "fixture.cancelable",
        status: "canceled",
        type: "stage-finish",
      });
      throw error;
    }
  };
}

function parseFixturePrUrl(prUrl) {
  const parts = new URL(prUrl).pathname.split("/").filter(Boolean);
  return { number: Number(parts.at(-1)) };
}
