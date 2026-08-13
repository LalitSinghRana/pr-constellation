import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBenchmarkRun } from "../review-run.js";
import { parseGitHubPrUrl } from "../workflow/02-fetch-pr/github.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pr-review-benchmark-"));
const reviewsDir = path.join(temporaryRoot, ".reviews");
const prUrl = "https://github.com/example/example/pull/7";
const reviewSlug = parseGitHubPrUrl(prUrl).slug;
const sourceRunDir = path.join(reviewsDir, reviewSlug, "source-run");
const targetRunDir = path.join(reviewsDir, reviewSlug, "target-run");
const events = [];
const codexCalls = [];
const runController = new AbortController();
const reviewStacksFixtureResult = {
  schemaVersion: "pr-review-stacks/v1",
  reviewStacks: [
    {
      id: "core-change",
      title: "Fixture value update",
      explanation: "Single cohesive change to the example file.",
      fileIds: ["file-1"],
    },
  ],
};
const reviewTreesFixtureResult = {
  schemaVersion: "pr-review-trees/v1",
  intent: "Replace the fixture value.",
  summary: "The fixture verifies frozen-input benchmark runs.",
  confidence: 1,
  fileTree: { branches: [] },
  files: [
    {
      id: "file-1",
      path: "src/example.js",
      reviewPriority: "primary",
      changeKind: "runtime",
      explanation: "This file changes the fixture value used by the benchmark.",
      sectionTree: {
        sections: [
          {
            id: "replace-value",
            title: "Replace the fixture value",
            reviewPriority: "primary",
            changeKind: "runtime",
            explanation: "The changed assignment is the complete runtime contract.",
            changedLineRanges: [
              {
                start: "file-1:hunk-1:line-1",
                end: "file-1:hunk-1:line-2",
              },
            ],
          },
        ],
        branches: [],
      },
    },
  ],
};
const judgeFixtureResult = {
  schemaVersion: "pr-review-judge/v1",
  verdict: "pass",
  confidence: 1,
  summary: "The fixture candidate is valid.",
  findings: [],
};
try {
  await mkdir(sourceRunDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(sourceRunDir, "metadata.json"),
      `${JSON.stringify({
        additions: 1,
        author: { login: "example" },
        baseRefName: "main",
        baseRefOid: "base-sha",
        changedFiles: 1,
        deletions: 1,
        headRefName: "feature",
        headRefOid: "head-sha",
        number: 7,
        state: "OPEN",
        title: "Benchmark fixture",
        url: prUrl,
      })}\n`,
      "utf8",
    ),
    writeFile(
      path.join(sourceRunDir, "diff.patch"),
      `diff --git a/src/example.js b/src/example.js
index 1111111..2222222 100644
--- a/src/example.js
+++ b/src/example.js
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`,
      "utf8",
    ),
  ]);

  const result = await createBenchmarkRun({
    executeCodex: async ({ model, outputPath, reasoningEffort, schemaPath, signal }) => {
      assert.equal(signal, runController.signal);
      codexCalls.push({ model, reasoningEffort, schemaPath });
      const value = schemaPath.includes("02-create-review-stacks")
        ? reviewStacksFixtureResult
        : schemaPath.includes("06-judge-candidate")
          ? judgeFixtureResult
          : reviewTreesFixtureResult;

      await writeFile(outputPath, `${JSON.stringify(value)}\n`, "utf8");
    },
    model: "gpt-fixture",
    onEvent: async (event) => {
      events.push(event);
    },
    prUrl,
    reasoningEffort: "low",
    reviewsDir,
    runDir: targetRunDir,
    signal: runController.signal,
    sourceRunDir,
  });

  assert.equal(result.metadata.headRefOid, "head-sha");
  assert.equal(result.diffSummary.changedLineCount, 2);
  assert.equal(result.runDir, targetRunDir);
  assert.ok(result.analysisPath.endsWith("analysis.json"));
  assert.equal(result.htmlPath, undefined);
  assert.equal(result.stableHtmlPath, undefined);
  assert.match(await readFile(result.analysisPath, "utf8"), /Replace the fixture value/);
  assert.equal(codexCalls.length, 2);
  assert.deepEqual(
    codexCalls.map(({ model, reasoningEffort }) => ({
      model,
      reasoningEffort,
    })),
    [
      { model: "gpt-fixture", reasoningEffort: "low" },
      { model: "gpt-fixture", reasoningEffort: "low" },
    ],
  );
  const claudeCalls = [];
  const claudeRunDir = path.join(reviewsDir, reviewSlug, "claude-run");
  await createBenchmarkRun({
    executeClaude: async ({ model, outputPath, reasoningEffort, schemaPath }) => {
      claudeCalls.push({ model, reasoningEffort });
      const value = schemaPath.includes("02-create-review-stacks")
        ? reviewStacksFixtureResult
        : schemaPath.includes("06-judge-candidate")
          ? judgeFixtureResult
          : reviewTreesFixtureResult;
      await writeFile(outputPath, `${JSON.stringify(value)}\n`, "utf8");
    },
    model: "claude-sonnet-4-6",
    prUrl,
    provider: "claude",
    reasoningEffort: "max",
    reviewsDir,
    runDir: claudeRunDir,
    sourceRunDir,
  });
  assert.deepEqual(claudeCalls, [
    { model: "claude-sonnet-4-6", reasoningEffort: "max" },
    { model: "claude-sonnet-4-6", reasoningEffort: "max" },
  ]);

  const starts = new Set(
    events.filter((event) => event.type === "stage-start").map((event) => event.stageId),
  );
  const finishes = new Map(
    events.filter((event) => event.type === "stage-finish").map((event) => [event.stageId, event]),
  );

  for (const stageId of [
    "input.reuse",
    "inventory",
    "inventory.parse",
    "inventory.summary",
    "input.persist",
    "analysis",
    "analysis.review-stacks",
    "analysis.attempt-1",
    "analysis.attempt-1.generate-review-trees",
    "analysis.attempt-1.evaluation",
    "analysis.attempt-1.evaluation.validate-candidate",
    "analysis.persist-artifacts",
  ]) {
    assert.equal(starts.has(stageId), true, `Missing start event for ${stageId}`);
    assert.equal(finishes.get(stageId)?.status, "completed");
    assert.equal(typeof finishes.get(stageId)?.metrics?.elapsedMs, "number");
  }
  assert.equal(finishes.get("analysis.attempt-1.evaluation.judge-candidate")?.status, "skipped");
  assert.equal(finishes.get("inventory.parse").parentStageId, "inventory");
  assert.equal(starts.has("render"), false);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

console.log("benchmark run checks passed");
