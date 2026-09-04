import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertStorageId,
  createRunManifest,
  createTimingsDocument,
  DASHBOARD_SCHEMA_VERSION,
  FROZEN_INPUT_FILES,
  RUN_SCHEMA_VERSION,
  RunStore,
  TIMINGS_SCHEMA_VERSION,
} from "../analysis/run-store.js";

const reviewsDir = await mkdtemp(path.join(os.tmpdir(), "pr-review-run-store-"));
const sourceInputContents = {
  "metadata.json": "{}\n",
  "diff.patch": "diff --git a/a.js b/a.js\n",
  "diff-inventory.json": "{}\n",
  "diff-summary.json": "{}\n",
};
let reloadedStore;
let store;

try {
  await chmod(reviewsDir, 0o755);
  store = new RunStore({
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

  const runDirectoryEntries = await readdir(path.join(reviewsDir, "widgets-42", "run-1"));
  const persistedRun = await store.readRun("widgets-42", "run-1");
  const persistedTimings = await store.readTimings("widgets-42", "run-1");
  assert.deepEqual(persistedRun, firstRun);
  assert.equal(persistedTimings.schemaVersion, TIMINGS_SCHEMA_VERSION);
  assert.equal(persistedTimings.runId, "run-1");
  assert.deepEqual(persistedTimings.stages, []);
  assert.equal(runDirectoryEntries.includes("run.json"), false);
  assert.equal(runDirectoryEntries.includes("timings.json"), false);
  assert.equal(
    runDirectoryEntries.some((name) => name.endsWith(".tmp")),
    false,
  );
  assert.equal((await readdir(reviewsDir)).includes(".run-store.sqlite"), true);
  assert.equal((await stat(reviewsDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(reviewsDir, ".run-store.sqlite"))).mode & 0o777, 0o600);

  await store.updateRun("widgets-42", "run-1", {
    status: "running",
    phase: "generate-review-trees",
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
    stageId: "file-tree",
    label: "Generate Review Trees",
    parentStageId: "analysis",
    attempt: 2,
    at: "2026-07-27T10:00:02.000Z",
  });
  const timingsAfterEnd = await store.recordStageEvent("widgets-42", "run-1", {
    type: "stage-finish",
    stageId: "file-tree",
    parentStageId: "analysis",
    attempt: 2,
    at: "2026-07-27T10:00:03.250Z",
    status: "succeeded",
    metrics: { elapsedMs: 1_234.5, outputTokens: 321 },
  });

  const sectionTreeStage = timingsAfterEnd.stages.find(
    (stage) => stage.stageId === "file-tree" && stage.attempt === 2,
  );
  assert.equal(sectionTreeStage.durationMs, 1_234.5);
  assert.equal(sectionTreeStage.parentStageId, "analysis");
  assert.equal(sectionTreeStage.status, "succeeded");
  assert.deepEqual(sectionTreeStage.metrics, { elapsedMs: 1_234.5, outputTokens: 321 });
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
  const completedRun = await store.createRun({
    runId: "run-1",
    url: "https://github.com/example/other/pull/7",
    owner: "example",
    repo: "other",
    number: 7,
    slug: "other-7",
    title: "A completed comparison run",
    status: "succeeded",
  });
  assert.equal(completedRun.reviewUrl, "/reviews/other-7/run-1/");

  reloadedStore = new RunStore({
    reviewsDir,
    clock: () => new Date("2026-07-27T10:05:00.000Z"),
  });
  assert.equal((await reloadedStore.readRun("widgets-42", "run-1")).phase, "generate-review-trees");

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
    recovered.map((run) => `${run.slug}/${run.runId}`),
    ["widgets-42/run-1"],
  );
  assert.equal((await reloadedStore.readRun("widgets-42", "run-1")).status, "interrupted");
  assert.equal((await reloadedStore.readRun("widgets-42", "run-2")).status, "queued");
  assert.equal((await reloadedStore.readRun("other-7", "run-1")).status, "succeeded");
  const recoveredTimings = await reloadedStore.readTimings("widgets-42", "run-1");
  const interruptedStage = recoveredTimings.stages.find((stage) => stage.stageId === "analysis");
  assert.equal(interruptedStage.status, "interrupted");
  assert.equal(interruptedStage.endedAt, "2026-07-27T10:05:00.000Z");
  assert.equal(interruptedStage.durationMs, 299_000);
  assert.equal(recoveredTimings.events.at(-1).status, "interrupted");

  for (const invalid of ["", ".", "..", "../escape", "nested/run", "/absolute", "a b"]) {
    assert.throws(() => assertStorageId(invalid), {
      code: "INVALID_STORAGE_ID",
    });
  }
  await assert.rejects(() => reloadedStore.readRun("../escape", "run-1"), {
    code: "INVALID_STORAGE_ID",
  });

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
    () => readdir(reloadedStore.getRunDir(disposableRun.slug, disposableRun.runId)),
    { code: "ENOENT" },
  );
  await assert.rejects(() => reloadedStore.readRun(disposableRun.slug, disposableRun.runId), {
    code: "ENOENT",
  });
  await assert.rejects(() => reloadedStore.readTimings(disposableRun.slug, disposableRun.runId), {
    code: "ENOENT",
  });
  await assert.rejects(() => reloadedStore.deleteRun("../escape", disposableRun.runId), {
    code: "INVALID_STORAGE_ID",
  });

  const linkedRun = await reloadedStore.createRun({
    runId: "linked-run",
    url: "https://github.com/example/disposable/pull/10",
    owner: "example",
    repo: "disposable",
    number: 10,
    slug: "disposable-10",
  });
  const linkedRunDir = reloadedStore.getRunDir(linkedRun.slug, linkedRun.runId);
  const protectedDir = await mkdtemp(path.join(os.tmpdir(), "pr-review-run-store-protected-"));
  try {
    const protectedFile = path.join(protectedDir, "keep.txt");
    await writeFile(protectedFile, "keep\n", "utf8");
    await rm(linkedRunDir, { recursive: true });
    await symlink(protectedDir, linkedRunDir);
    await assert.rejects(() => reloadedStore.deleteRun(linkedRun.slug, linkedRun.runId), {
      code: "INVALID_RUN_DOCUMENT",
    });
    assert.equal(await readFile(protectedFile, "utf8"), "keep\n");
    await unlink(linkedRunDir);
    assert.equal(
      (await reloadedStore.deleteRun(linkedRun.slug, linkedRun.runId)).runId,
      "linked-run",
    );
  } finally {
    await rm(protectedDir, { force: true, recursive: true });
  }

  await verifyLegacyMigration();
  await verifyConcurrentStores();

  console.log("run store checks passed");
} finally {
  reloadedStore?.close();
  store?.close();
  await rm(reviewsDir, { force: true, recursive: true });
}

async function verifyLegacyMigration() {
  const legacyReviewsDir = await mkdtemp(path.join(os.tmpdir(), "pr-review-run-store-legacy-"));
  const legacyRunDir = path.join(legacyReviewsDir, "legacy-8", "old-run");
  const legacyManifest = createRunManifest(
    {
      runId: "old-run",
      url: "https://github.com/example/legacy/pull/8",
      owner: "example",
      repo: "legacy",
      number: 8,
      slug: "legacy-8",
      title: "Imported JSON run",
    },
    "2026-07-26T09:00:00.000Z",
  );
  const legacyTimings = createTimingsDocument("old-run", "2026-07-26T09:00:00.000Z");
  const manifestJson = `${JSON.stringify(legacyManifest, null, 2)}\n`;
  const timingsJson = `${JSON.stringify(legacyTimings, null, 2)}\n`;
  let migratedStore;
  let reopenedStore;

  try {
    await mkdir(legacyRunDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(legacyRunDir, "run.json"), manifestJson, "utf8"),
      writeFile(path.join(legacyRunDir, "timings.json"), timingsJson, "utf8"),
    ]);

    migratedStore = new RunStore({
      reviewsDir: legacyReviewsDir,
      clock: () => new Date("2026-07-27T11:00:00.000Z"),
    });
    assert.equal((await migratedStore.readRun("legacy-8", "old-run")).title, "Imported JSON run");

    await migratedStore.updateRun("legacy-8", "old-run", {
      phase: "migrated",
      status: "running",
    });
    await migratedStore.recordStageEvent("legacy-8", "old-run", {
      type: "stage-start",
      stageId: "migration-check",
      at: "2026-07-27T11:00:01.000Z",
    });
    assert.equal(await readFile(path.join(legacyRunDir, "run.json"), "utf8"), manifestJson);
    assert.equal(await readFile(path.join(legacyRunDir, "timings.json"), "utf8"), timingsJson);

    migratedStore.close();
    migratedStore = null;
    await rm(legacyRunDir, { recursive: true });

    reopenedStore = new RunStore({ reviewsDir: legacyReviewsDir });
    assert.equal((await reopenedStore.readRun("legacy-8", "old-run")).phase, "migrated");
    assert.equal((await reopenedStore.readTimings("legacy-8", "old-run")).events.length, 1);
    assert.deepEqual(
      (await reopenedStore.scanRuns()).map((run) => `${run.slug}/${run.runId}`),
      ["legacy-8/old-run"],
    );
    assert.equal((await reopenedStore.deleteRun("legacy-8", "old-run")).runId, "old-run");
    await assert.rejects(() => reopenedStore.readRun("legacy-8", "old-run"), { code: "ENOENT" });
  } finally {
    reopenedStore?.close();
    migratedStore?.close();
    await rm(legacyReviewsDir, { force: true, recursive: true });
  }
}

async function verifyConcurrentStores() {
  const concurrentReviewsDir = await mkdtemp(
    path.join(os.tmpdir(), "pr-review-run-store-concurrent-"),
  );
  let firstStore;
  const pendingUpdates = [];
  let releaseUpdate = () => {};
  let secondStore;

  try {
    firstStore = new RunStore({ reviewsDir: concurrentReviewsDir });
    secondStore = new RunStore({ reviewsDir: concurrentReviewsDir });
    await firstStore.createRun({
      runId: "shared-run",
      url: "https://github.com/example/concurrent/pull/3",
      owner: "example",
      repo: "concurrent",
      number: 3,
      slug: "concurrent-3",
    });

    let notifyUpdateStarted;
    const updateStarted = new Promise((resolve) => {
      notifyUpdateStarted = resolve;
    });
    const updateCanFinish = new Promise((resolve) => {
      releaseUpdate = resolve;
    });
    const staleUpdate = firstStore.updateRun("concurrent-3", "shared-run", async () => {
      notifyUpdateStarted();
      await updateCanFinish;
      return { phase: "stale" };
    });
    pendingUpdates.push(staleUpdate);
    await updateStarted;
    await secondStore.updateRun("concurrent-3", "shared-run", { phase: "winner" });
    releaseUpdate();
    await assert.rejects(() => staleUpdate, { code: "RUN_UPDATE_CONFLICT" });
    assert.equal((await firstStore.readRun("concurrent-3", "shared-run")).phase, "winner");

    let notifyDeleteRaceStarted;
    const deleteRaceStarted = new Promise((resolve) => {
      notifyDeleteRaceStarted = resolve;
    });
    const deleteRaceCanFinish = new Promise((resolve) => {
      releaseUpdate = resolve;
    });
    const deletedUpdate = firstStore.updateRun("concurrent-3", "shared-run", async () => {
      notifyDeleteRaceStarted();
      await deleteRaceCanFinish;
      return { phase: "deleted" };
    });
    pendingUpdates.push(deletedUpdate);
    await deleteRaceStarted;
    await secondStore.deleteRun("concurrent-3", "shared-run");
    releaseUpdate();
    await assert.rejects(() => deletedUpdate, { code: "ENOENT" });
  } finally {
    releaseUpdate();
    await Promise.allSettled(pendingUpdates);
    secondStore?.close();
    firstStore?.close();
    await rm(concurrentReviewsDir, { force: true, recursive: true });
  }
}
