import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createBenchmarkRun,
  publishStableReview,
} from "../cli/review-run.js";
import { parseGitHubPrUrl } from "../workflows/pr-graph-analysis/02-fetch-pr/github.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pr-review-benchmark-"));
const reviewsDir = path.join(temporaryRoot, ".reviews");
const prUrl = "https://github.com/example/example/pull/7";
const reviewSlug = parseGitHubPrUrl(prUrl).slug;
const sourceRunDir = path.join(reviewsDir, reviewSlug, "source-run");
const targetRunDir = path.join(reviewsDir, reviewSlug, "target-run");
const events = [];
const codexCalls = [];
const runController = new AbortController();
const stableHtmlPath = path.join(reviewsDir, reviewSlug, "index.html");
const previousStableHtml = "<p>previous successful graph</p>";
const reviewStackFixtureResult = {
  schemaVersion: "pr-graph-review-stack/v1",
  stacks: [{
    id: "core-change",
    title: "Fixture value update",
    comment: "Single cohesive change to the example file.",
    fileIds: ["file-1"],
  }],
};

try {
  await mkdir(sourceRunDir, { recursive: true });
  await Promise.all([
    writeFile(stableHtmlPath, previousStableHtml, "utf8"),
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
    executeCodex: async ({
      model,
      outputPath,
      reasoningEffort,
      schemaPath,
      signal,
    }) => {
      assert.equal(signal, runController.signal);
      codexCalls.push({ model, reasoningEffort, schemaPath });
      const value = schemaPath.includes("03-create-review-stack")
        ? reviewStackFixtureResult
        : schemaPath.includes("06-judge-candidate")
        ? {
            schemaVersion: "pr-graph-judge/v1",
            verdict: "pass",
            confidence: 1,
            summary: "The fixture candidate is valid.",
            findings: [],
          }
        : {
            schemaVersion: "pr-graph-mini-trees/v2",
            intent: "Replace the fixture value.",
            summary: "The fixture verifies frozen-input benchmark runs.",
            confidence: 1,
            fileFlow: { edges: [] },
            files: [
              {
                id: "file-1",
                path: "src/example.js",
                reviewClass: "important",
                changeRole: "runtime",
                comment: "This file changes the fixture value used by the benchmark.",
                miniTree: {
                  nodes: [
                    {
                      id: "replace-value",
                      title: "Replace the fixture value",
                      reviewClass: "important",
                      changeRole: "runtime",
                      comment: "The changed assignment is the complete runtime contract.",
                      changedLineRanges: [{
                        start: "file-1:hunk-1:line-1",
                        end: "file-1:hunk-1:line-2",
                      }],
                    },
                  ],
                  reviewEdges: [],
                  relations: [],
                },
              },
            ],
          };

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
  assert.match(await readFile(result.htmlPath, "utf8"), /Benchmark fixture/);
  assert.equal(
    await readFile(result.stableHtmlPath, "utf8"),
    previousStableHtml,
  );
  const {
    fileFlows: fixtureFileFlows,
    reviewStack: _fixtureReviewStack,
    ...fixtureAnalysis
  } = JSON.parse(await readFile(result.analysisPath, "utf8"));
  const miniTreesFixture = `${JSON.stringify({
    ...fixtureAnalysis,
    fileFlow: fixtureFileFlows[reviewStackFixtureResult.stacks[0].id],
  })}\n`;

  const claudeCalls = [];
  const claudeRunDir = path.join(reviewsDir, reviewSlug, "claude-run");
  await createBenchmarkRun({
    executeClaude: async ({
      model,
      outputPath,
      reasoningEffort,
      schemaPath,
    }) => {
      claudeCalls.push({ model, reasoningEffort });
      if (schemaPath.includes("03-create-review-stack")) {
        await writeFile(outputPath, await readFile(path.join(result.runDir, "review-stack.json"), "utf8"), "utf8");
      } else if (schemaPath.includes("06-judge-candidate")) {
        await writeFile(outputPath, await readFile(result.judgePath, "utf8"), "utf8");
      } else {
        await writeFile(outputPath, miniTreesFixture, "utf8");
      }
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

  await assert.rejects(
    publishStableReview({
      htmlPath: path.join(targetRunDir, "missing-index.html"),
      stableHtmlPath,
    }),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(stableHtmlPath, "utf8"), previousStableHtml);
  assert.equal(
    (await readdir(path.dirname(stableHtmlPath))).some(
      (entry) => entry.startsWith(".index.html.") && entry.endsWith(".tmp"),
    ),
    false,
  );

  await publishStableReview({
    htmlPath: result.htmlPath,
    stableHtmlPath: result.stableHtmlPath,
  });
  assert.equal(
    await readFile(result.stableHtmlPath, "utf8"),
    await readFile(result.htmlPath, "utf8"),
  );
  await writeFile(stableHtmlPath, previousStableHtml, "utf8");

  const starts = new Set(
    events
      .filter((event) => event.type === "stage-start")
      .map((event) => event.stageId),
  );
  const finishes = new Map(
    events
      .filter((event) => event.type === "stage-finish")
      .map((event) => [event.stageId, event]),
  );

  for (const stageId of [
    "input.reuse",
    "inventory",
    "inventory.parse",
    "inventory.summary",
    "input.persist",
    "analysis",
    "analysis.review-stack",
    "analysis.attempt-1",
    "analysis.attempt-1.generate-mini-trees",
    "analysis.attempt-1.evaluation",
    "analysis.attempt-1.evaluation.validate-candidate",
    "analysis.persist-artifacts",
    "render",
    "render.build",
    "render.persist",
  ]) {
    assert.equal(starts.has(stageId), true, `Missing start event for ${stageId}`);
    assert.equal(finishes.get(stageId)?.status, "completed");
    assert.equal(typeof finishes.get(stageId)?.metrics?.elapsedMs, "number");
  }
  assert.equal(
    finishes.get("analysis.attempt-1.evaluation.judge-candidate")?.status,
    "skipped",
  );

  assert.equal(
    finishes.get("inventory.parse").parentStageId,
    "inventory",
  );
  assert.equal(finishes.get("render.persist").parentStageId, "render");

  const renderCancelController = new AbortController();
  const renderCancelEvents = [];
  const canceledRenderRunDir = path.join(
    reviewsDir,
    reviewSlug,
    "canceled-render-run",
  );
  const [judgeFixture, reviewStackFixture] = await Promise.all([
    readFile(result.judgePath, "utf8"),
    readFile(path.join(result.runDir, "review-stack.json"), "utf8"),
  ]);
  let renderCancelError;

  await assert.rejects(
    createBenchmarkRun({
      executeCodex: async ({ outputPath, schemaPath, signal }) => {
        assert.equal(signal, renderCancelController.signal);
        await writeFile(
          outputPath,
          schemaPath.includes("03-create-review-stack")
            ? reviewStackFixture
            : schemaPath.includes("06-judge-candidate")
              ? judgeFixture
              : miniTreesFixture,
          "utf8",
        );
        return {
          usage: {
            inputTokens: 12,
            cachedInputTokens: 4,
            outputTokens: 3,
            totalTokens: 15,
          },
        };
      },
      model: "gpt-fixture",
      onEvent: async (event) => {
        renderCancelEvents.push(event);
        if (
          event.type === "stage-start"
          && event.stageId === "render.persist"
        ) {
          renderCancelController.abort(
            new Error("Canceled before rendering the review graph."),
          );
        }
      },
      prUrl,
      reasoningEffort: "low",
      reviewsDir,
      runDir: canceledRenderRunDir,
      signal: renderCancelController.signal,
      sourceRunDir,
    }),
    (error) => {
      renderCancelError = error;
      return error?.name === "AbortError" && error?.code === "ABORT_ERR";
    },
  );

  assert.deepEqual(renderCancelError.usage, {
    inputTokens: 24,
    cachedInputTokens: 8,
    outputTokens: 6,
    totalTokens: 30,
  });
  assert.equal(
    renderCancelEvents.find(
      (event) => event.type === "stage-finish" && event.stageId === "analysis",
    )?.status,
    "completed",
  );
  assert.equal(
    renderCancelEvents.find(
      (event) => event.type === "stage-finish" && event.stageId === "render",
    )?.status,
    "canceled",
  );
  assert.equal(
    renderCancelEvents.find(
      (event) => (
        event.type === "stage-finish"
        && event.stageId === "render.persist"
      ),
    )?.status,
    "completed",
  );
  assert.match(
    await readFile(path.join(canceledRenderRunDir, "index.html"), "utf8"),
    /Benchmark fixture/,
  );
  assert.equal(await readFile(stableHtmlPath, "utf8"), previousStableHtml);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

console.log("benchmark run checks passed");
