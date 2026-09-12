import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DashboardService } from "../analysis/dashboard-service.js";
import { RunStore } from "../analysis/run-store.js";

test("dashboard service resumes queued runs after a restart", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-dashboard-restart-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const reviewsDir = path.join(root, ".reviews");
  const seededStore = new RunStore({ reviewsDir });
  await seededStore.createRun({
    metrics: {
      model: "gpt-fixture",
      provider: "cursor",
      reasoningEffort: "high",
    },
    number: 7,
    owner: "example",
    repo: "durable",
    runId: "queued-before-restart",
    slug: "example-durable-pr-7",
    status: "queued",
    title: "Resume me",
    url: "https://github.com/example/durable/pull/7",
  });
  seededStore.close();

  const executions = [];
  const service = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      reasoningEfforts: ["low", "high"],
    },
    getCodeVersion: async () => ({ commit: "fixture", dirty: false, fingerprint: "fixture" }),
    projectRoot: root,
    reviewsDir,
    runExecutor: async (options) => {
      executions.push(options);
      throw new Error("Stop after proving the durable job resumed.");
    },
  });

  await service.initialize();
  await service.waitForIdle();
  const stored = await service.store.readRun("example-durable-pr-7", "queued-before-restart");
  assert.equal(stored.status, "failed");
  assert.equal(executions.length, 1);
  assert.equal(executions[0].model, "gpt-fixture");
  assert.equal(executions[0].reasoningEffort, "high");
  await service.close();
});

test("dashboard service restarts an incomplete batch source before equal-time dependents", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-dashboard-batch-restart-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const reviewsDir = path.join(root, ".reviews");
  const seededStore = new RunStore({ reviewsDir });
  const timestamp = "2026-08-06T12:00:00.000Z";
  const common = {
    metrics: {
      batchId: "batch-before-restart",
      batchSize: 2,
      model: "gpt-fixture",
      provider: "cursor",
    },
    number: 8,
    owner: "example",
    repo: "durable",
    slug: "example-durable-pr-8",
    title: "Resume batch",
    timestamps: { createdAt: timestamp, queuedAt: timestamp },
    url: "https://github.com/example/durable/pull/8",
  };
  await seededStore.createRun({
    ...common,
    metrics: { ...common.metrics, batchIndex: 0, reasoningEffort: "low" },
    runId: "z-source",
    status: "running",
  });
  await seededStore.recordStageEvent(common.slug, "z-source", {
    at: timestamp,
    label: "Total analysis run",
    stageId: "run.total",
    type: "stage-start",
  });
  await seededStore.createRun({
    ...common,
    metrics: { ...common.metrics, batchIndex: 1, reasoningEffort: "high" },
    runId: "a-dependent",
    sourceMode: "frozen",
    sourceRunId: "z-source",
    status: "queued",
  });
  seededStore.close();

  const executions = [];
  const service = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      reasoningEfforts: ["low", "high"],
    },
    getCodeVersion: async () => ({ commit: "fixture", dirty: false, fingerprint: "fixture" }),
    projectRoot: root,
    reviewsDir,
    runExecutor: async (options) => {
      executions.push(options);
      await writeFrozenInputs(options.runDir);
      return {
        diffSummary: { changedLineCount: 1, files: [] },
        metadata: {
          additions: 1,
          baseRefOid: "base",
          changedFiles: 1,
          deletions: 0,
          headRefOid: "head",
          title: "Resume batch",
        },
      };
    },
  });

  await service.initialize();
  await service.waitForIdle();

  assert.deepEqual(
    executions.map((execution) => execution.reasoningEffort),
    ["low", "high"],
  );
  assert.equal(executions[0].sourceRunDir, null);
  assert.equal(
    executions[1].sourceRunDir,
    await realpath(service.store.getRunDir(common.slug, "z-source")),
  );
  assert.equal((await service.store.readRun(common.slug, "z-source")).status, "succeeded");
  assert.equal((await service.store.readRun(common.slug, "a-dependent")).status, "succeeded");
  assert.deepEqual(
    (await service.store.readTimings(common.slug, "z-source")).stages
      .filter((stage) => stage.stageId === "run.total")
      .map((stage) => [stage.attempt, stage.status]),
    [
      [1, "interrupted"],
      [2, "completed"],
    ],
  );
  await service.close();
});

test("dashboard service records unsupported queued configuration instead of changing it", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-dashboard-config-restart-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const reviewsDir = path.join(root, ".reviews");
  const seededStore = new RunStore({ reviewsDir });
  await seededStore.createRun({
    metrics: {
      model: "gpt-removed",
      provider: "cursor",
      reasoningEffort: "high",
    },
    number: 9,
    owner: "example",
    repo: "durable",
    runId: "unsupported-before-restart",
    slug: "example-durable-pr-9",
    status: "queued",
    title: "Do not silently change me",
    url: "https://github.com/example/durable/pull/9",
  });
  seededStore.close();

  let executionCount = 0;
  const service = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      reasoningEfforts: ["low", "high"],
    },
    projectRoot: root,
    reviewsDir,
    runExecutor: async () => {
      executionCount += 1;
    },
  });

  await service.initialize();
  const stored = await service.store.readRun("example-durable-pr-9", "unsupported-before-restart");
  assert.equal(executionCount, 0);
  assert.equal(stored.status, "failed");
  assert.equal(stored.error.code, "UNSUPPORTED_STORED_CONFIGURATION");
  assert.match(stored.error.message, /gpt-removed/);
  await service.close();
});

async function writeFrozenInputs(runDir) {
  await Promise.all([
    writeFile(path.join(runDir, "metadata.json"), '{"title":"Resume batch"}\n', "utf8"),
    writeFile(path.join(runDir, "diff.patch"), "fixture diff\n", "utf8"),
    writeFile(path.join(runDir, "diff-inventory.json"), "[]\n", "utf8"),
    writeFile(path.join(runDir, "diff-summary.json"), '{"files":[]}\n', "utf8"),
  ]);
}
