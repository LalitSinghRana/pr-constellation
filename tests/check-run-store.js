import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DASHBOARD_SCHEMA_VERSION,
  FROZEN_INPUT_FILES,
  RUN_SCHEMA_VERSION,
  RunStore,
  TIMINGS_SCHEMA_VERSION,
  assertStorageId,
} from "../cli/run-store.js";

const reviewsDir = await mkdtemp(path.join(os.tmpdir(), "pr-review-run-store-"));
const sourceInputContents = {
  "metadata.json": "{}\n",
  "diff.patch": "diff --git a/a.js b/a.js\n",
  "diff-inventory.json": "{}\n",
  "diff-summary.json": "{}\n",
};

try {
  const store = new RunStore({
    reviewsDir,
    clock: () => new Date("2026-07-27T10:00:00.000Z"),
  });

  const firstRun = await store.createRun({
    runId: "run-1",
    url: "https://github.com/example/widgets/pull/42",
    owner: "example",
    repo: "widgets",
    number: 42,
    slug: "widgets-42",
    title: "Measure every analysis stage",
    headSha: "abc123",
    baseSha: "def456",
    gitCommit: "commit-one",
    metrics: {
      changedFiles: 28,
      additions: 1_200,
      deletions: 800,
      changedLines: 2_000,
    },
  });

  assert.equal(firstRun.schemaVersion, RUN_SCHEMA_VERSION);
  assert.equal(firstRun.status, "queued");
  assert.equal(firstRun.sourceMode, "fresh");
  assert.equal(firstRun.sourceRunId, null);

  const persistedRun = JSON.parse(
    await readFile(path.join(reviewsDir, "widgets-42", "run-1", "run.json"), "utf8"),
  );
  const persistedTimings = JSON.parse(
    await readFile(path.join(reviewsDir, "widgets-42", "run-1", "timings.json"), "utf8"),
  );
  assert.deepEqual(persistedRun, firstRun);
  assert.equal(persistedTimings.schemaVersion, TIMINGS_SCHEMA_VERSION);
  assert.equal(persistedTimings.runId, "run-1");
  assert.deepEqual(persistedTimings.stages, []);
  assert.equal(
    (await readdir(path.join(reviewsDir, "widgets-42", "run-1"))).some((name) =>
      name.endsWith(".tmp"),
    ),
    false,
  );

  await store.updateRun("widgets-42", "run-1", {
    status: "running",
    phase: "generate-mini-trees",
  });
  await store.recordStageEvent("widgets-42", "run-1", {
    type: "stage-start",
    stageId: "analysis",
    label: "Generate analysis",
    at: "2026-07-27T10:00:01.000Z",
    metrics: { model: "gpt-5-mini" },
  });
  await store.recordStageEvent("widgets-42", "run-1", {
    type: "stage-start",
    stageId: "mini-tree",
    label: "Generate mini-trees",
    parentStageId: "analysis",
    attempt: 2,
    at: "2026-07-27T10:00:02.000Z",
  });
  const timingsAfterEnd = await store.recordStageEvent("widgets-42", "run-1", {
    type: "stage-finish",
    stageId: "mini-tree",
    parentStageId: "analysis",
    attempt: 2,
    at: "2026-07-27T10:00:03.250Z",
    status: "succeeded",
    metrics: { elapsedMs: 1_234.5, outputTokens: 321 },
  });

  const miniTreeStage = timingsAfterEnd.stages.find(
    (stage) => stage.stageId === "mini-tree" && stage.attempt === 2,
  );
  assert.equal(miniTreeStage.durationMs, 1_234.5);
  assert.equal(miniTreeStage.parentStageId, "analysis");
  assert.equal(miniTreeStage.status, "succeeded");
  assert.deepEqual(miniTreeStage.metrics, { elapsedMs: 1_234.5, outputTokens: 321 });
  assert.equal(
    timingsAfterEnd.stages.find((stage) => stage.stageId === "analysis").durationMs,
    2_250,
  );
  assert.equal(timingsAfterEnd.totalDurationMs, 2_250);
  assert.equal(timingsAfterEnd.events.length, 3);

  const sourceDir = path.join(reviewsDir, "widgets-42", "run-1");
  await Promise.all(
    Object.entries(sourceInputContents).map(([filename, contents]) =>
      writeFile(path.join(sourceDir, filename), contents, "utf8"),
    ),
  );

  await store.createRun({
    runId: "run-2",
    url: "https://github.com/example/widgets/pull/42",
    owner: "example",
    repo: "widgets",
    number: 42,
    slug: "widgets-42",
    title: "",
    headSha: "abc123",
    baseSha: "def456",
    sourceMode: "frozen",
    sourceRunId: "run-1",
  });
  await store.createRun({
    runId: "run-1",
    url: "https://github.com/example/other/pull/7",
    owner: "example",
    repo: "other",
    number: 7,
    slug: "other-7",
    title: "A completed comparison run",
    status: "succeeded",
    graphUrl: "/reviews/other-7/run-1/",
  });

  const reloadedStore = new RunStore({
    reviewsDir,
    clock: () => new Date("2026-07-27T10:05:00.000Z"),
  });
  assert.equal((await reloadedStore.readRun("widgets-42", "run-1")).phase, "generate-mini-trees");

  const dashboard = await reloadedStore.scanDashboard();
  assert.equal(dashboard.schemaVersion, DASHBOARD_SCHEMA_VERSION);
  assert.equal(dashboard.pullRequests.length, 2);
  assert.equal(
    dashboard.pullRequests.find((pullRequest) => pullRequest.slug === "widgets-42").runs.length,
    2,
  );
  assert.equal(
    dashboard.pullRequests.find((pullRequest) => pullRequest.slug === "widgets-42").title,
    "Measure every analysis stage",
  );
  assert.equal(
    dashboard.pullRequests
      .find((pullRequest) => pullRequest.slug === "widgets-42")
      .runs.find((run) => run.runId === "run-1").timings.stages.length,
    2,
  );

  const frozen = await reloadedStore.resolveSourceInputs({
    slug: "widgets-42",
    runId: "run-2",
  });
  assert.equal(frozen.run.runId, "run-1");
  assert.equal(frozen.runDir, await realpath(sourceDir));
  for (const [property, filename] of Object.entries(FROZEN_INPUT_FILES)) {
    assert.equal(frozen[property], await realpath(path.join(sourceDir, filename)));
  }

  const recovered = await reloadedStore.recoverInterruptedRuns();
  assert.deepEqual(
    recovered.map((run) => `${run.slug}/${run.runId}`).sort(),
    ["widgets-42/run-1", "widgets-42/run-2"],
  );
  assert.equal((await reloadedStore.readRun("widgets-42", "run-1")).status, "interrupted");
  assert.equal((await reloadedStore.readRun("widgets-42", "run-2")).status, "interrupted");
  assert.equal((await reloadedStore.readRun("other-7", "run-1")).status, "succeeded");
  const recoveredTimings = await reloadedStore.readTimings("widgets-42", "run-1");
  const interruptedStage = recoveredTimings.stages.find(
    (stage) => stage.stageId === "analysis",
  );
  assert.equal(interruptedStage.status, "interrupted");
  assert.equal(interruptedStage.endedAt, "2026-07-27T10:05:00.000Z");
  assert.equal(interruptedStage.durationMs, 299_000);
  assert.equal(recoveredTimings.events.at(-1).status, "interrupted");

  for (const invalid of ["", ".", "..", "../escape", "nested/run", "/absolute", "a b"]) {
    assert.throws(() => assertStorageId(invalid), {
      code: "INVALID_STORAGE_ID",
    });
  }
  await assert.rejects(
    () => reloadedStore.readRun("../escape", "run-1"),
    { code: "INVALID_STORAGE_ID" },
  );

  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "pr-review-run-store-outside-"));
  try {
    const escapedInput = path.join(outsideDir, "diff.patch");
    await writeFile(escapedInput, "outside\n", "utf8");
    await rm(path.join(sourceDir, "diff.patch"));
    await symlink(escapedInput, path.join(sourceDir, "diff.patch"));
    await assert.rejects(
      () =>
        reloadedStore.resolveFrozenSource({
          slug: "widgets-42",
          sourceRunId: "run-1",
        }),
      { code: "SOURCE_PATH_ESCAPE" },
    );
  } finally {
    await rm(outsideDir, { force: true, recursive: true });
  }

  await assert.rejects(
    () =>
      store.createRun({
        runId: "run-1",
        url: "https://github.com/example/widgets/pull/42",
        owner: "example",
        repo: "widgets",
        number: 42,
        slug: "widgets-42",
      }),
    { code: "RUN_ALREADY_EXISTS" },
  );

  await mkdir(path.join(reviewsDir, "ignored", "legacy-run"), { recursive: true });
  await mkdir(path.join(reviewsDir, "broken-1", "run-1"), { recursive: true });
  await writeFile(
    path.join(reviewsDir, "broken-1", "run-1", "run.json"),
    "{not valid json",
    "utf8",
  );
  assert.equal((await reloadedStore.scanRuns()).length, 3);

  const disposableRun = await reloadedStore.createRun({
    runId: "delete-me",
    url: "https://github.com/example/disposable/pull/9",
    owner: "example",
    repo: "disposable",
    number: 9,
    slug: "disposable-9",
  });
  assert.equal(
    (await reloadedStore.deleteRun(disposableRun.slug, disposableRun.runId)).runId,
    disposableRun.runId,
  );
  await assert.rejects(
    () => reloadedStore.readRun(disposableRun.slug, disposableRun.runId),
    { code: "ENOENT" },
  );
  await assert.rejects(
    () => reloadedStore.deleteRun("../escape", disposableRun.runId),
    { code: "INVALID_STORAGE_ID" },
  );

  console.log("run store checks passed");
} finally {
  await rm(reviewsDir, { force: true, recursive: true });
}
