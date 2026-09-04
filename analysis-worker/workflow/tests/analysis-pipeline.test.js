import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchPullRequest, ghText, parseGitHubPrUrl } from "../02-fetch-pr/github.js";
import { createDiffInventory } from "../03-build-diff-inventory/diff-inventory.js";
import {
  createTaskLimiter,
  materializeLineOwnership,
  runReviewAnalysis,
  validateReviewAnalysis,
} from "../07-run-retry-loop/review-analysis.js";

const limitOneTask = createTaskLimiter(1);
let releaseLimitedTask;
const activeLimitedTask = limitOneTask(
  () =>
    new Promise((resolve) => {
      releaseLimitedTask = resolve;
    }),
);
const waitingTaskController = new AbortController();
let waitingTaskStarted = false;
const waitingLimitedTask = limitOneTask(async () => {
  waitingTaskStarted = true;
}, waitingTaskController.signal);
waitingTaskController.abort(new Error("Cancel before a model slot is available."));
await assert.rejects(
  Promise.race([
    waitingLimitedTask,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Canceled limiter acquisition did not settle.")), 100),
    ),
  ]),
  (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
);
assert.equal(waitingTaskStarted, false);
releaseLimitedTask();
await activeLimitedTask;

const parsedPr = parseGitHubPrUrl("https://github.com/ExampleOwner/example-repo/pull/4812");
assert.deepEqual(parsedPr, {
  owner: "ExampleOwner",
  repo: "example-repo",
  number: "4812",
  slug: "gh-12-exampleowner-12-example-repo-4812",
});
assert.notEqual(
  parsedPr.slug,
  parseGitHubPrUrl("https://github.com/AnotherOwner/example-repo/pull/4812").slug,
);
assert.notEqual(
  parseGitHubPrUrl("https://github.com/a-b/c/pull/1").slug,
  parseGitHubPrUrl("https://github.com/a/b-c/pull/1").slug,
);
assert.equal(
  parseGitHubPrUrl("https://github.com/EXAMPLEOWNER/EXAMPLE-REPO/pull/4812").slug,
  parsedPr.slug,
);

const snapshotPrUrl = "https://github.com/acme/widgets/pull/42";
const initialSnapshotMetadata = buildPrMetadata({
  baseSha: "base-a",
  headSha: "head-a",
});
const updatedSnapshotMetadata = buildPrMetadata({
  baseSha: "base-a",
  headSha: "head-b",
});
const snapshotEvents = [];
const snapshotCalls = [];
const snapshotMetadataResponses = [
  initialSnapshotMetadata,
  updatedSnapshotMetadata,
  updatedSnapshotMetadata,
  updatedSnapshotMetadata,
];
const snapshotDiffResponses = ["diff from head-a", "diff from head-b"];
const snapshotResult = await fetchPullRequest(snapshotPrUrl, {
  executeGh: createFakeGh({
    calls: snapshotCalls,
    diffs: snapshotDiffResponses,
    metadata: snapshotMetadataResponses,
  }),
  onEvent: async (event) => {
    snapshotEvents.push(event);
  },
});

assert.equal(snapshotResult.diff, "diff from head-b");
assert.deepEqual(snapshotResult.metadata, updatedSnapshotMetadata);
assert.equal(snapshotCalls.filter((args) => args[0] === "pr" && args[1] === "diff").length, 2);
assertStagePairs(snapshotEvents);
assert.equal(findFinishEvent(snapshotEvents, "input.fetch.snapshot").metrics.attempts, 2);
assert.equal(findFinishEvent(snapshotEvents, "input.fetch.snapshot.attempt-1").status, "failed");
assert.equal(
  findFinishEvent(snapshotEvents, "input.fetch.snapshot.attempt-1").metrics.willRetry,
  true,
);
assert.equal(
  findFinishEvent(snapshotEvents, "input.fetch.snapshot.attempt-1.verify-refs").metrics
    .snapshotConsistent,
  false,
);
assert.equal(findFinishEvent(snapshotEvents, "input.fetch.snapshot.attempt-2").status, "completed");
assert.equal(
  findFinishEvent(snapshotEvents, "input.fetch.snapshot.attempt-2").metrics.headSha,
  "head-b",
);

const movingSnapshotEvents = [];
const movingSnapshotCalls = [];
await assert.rejects(
  fetchPullRequest(snapshotPrUrl, {
    executeGh: createFakeGh({
      calls: movingSnapshotCalls,
      diffs: ["diff-a", "diff-b", "diff-c"],
      metadata: [
        buildPrMetadata({ baseSha: "base-a", headSha: "head-a" }),
        buildPrMetadata({ baseSha: "base-a", headSha: "head-b" }),
        buildPrMetadata({ baseSha: "base-a", headSha: "head-b" }),
        buildPrMetadata({ baseSha: "base-b", headSha: "head-b" }),
        buildPrMetadata({ baseSha: "base-b", headSha: "head-b" }),
        buildPrMetadata({ baseSha: "base-b", headSha: "head-c" }),
      ],
    }),
    onEvent: async (event) => {
      movingSnapshotEvents.push(event);
    },
  }),
  /changed during 3 consecutive snapshot attempts/,
);
assert.equal(
  movingSnapshotCalls.filter((args) => args[0] === "pr" && args[1] === "diff").length,
  3,
);
assertStagePairs(movingSnapshotEvents);
assert.equal(
  findFinishEvent(movingSnapshotEvents, "input.fetch.snapshot.attempt-3").metrics.willRetry,
  false,
);
assert.equal(findFinishEvent(movingSnapshotEvents, "input.fetch.snapshot").status, "failed");

const fetchAbortController = new AbortController();
const fetchAbortEvents = [];
const fetchAbortMetadata = buildPrMetadata({
  baseSha: "base-abort",
  headSha: "head-abort",
});
await assert.rejects(
  fetchPullRequest(snapshotPrUrl, {
    executeGh: async (args, { signal } = {}) => {
      assert.equal(signal, fetchAbortController.signal);

      if (args[0] === "--version") {
        return "gh version test";
      }
      if (args[0] === "auth" && args[1] === "status") {
        return "authenticated";
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify(fetchAbortMetadata);
      }
      if (args[0] === "pr" && args[1] === "diff") {
        queueMicrotask(() =>
          fetchAbortController.abort(new Error("Canceled while fetching the PR diff.")),
        );
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("Canceled while fetching the PR diff.");
              error.name = "AbortError";
              error.code = "ABORT_ERR";
              reject(error);
            },
            { once: true },
          );
        });
      }

      assert.fail(`Unexpected gh invocation: ${args.join(" ")}`);
    },
    onEvent: async (event) => {
      fetchAbortEvents.push(event);
    },
    signal: fetchAbortController.signal,
  }),
  (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
);
assert.equal(
  findFinishEvent(fetchAbortEvents, "input.fetch.snapshot.attempt-1.diff").status,
  "canceled",
);
assert.equal(
  findFinishEvent(fetchAbortEvents, "input.fetch.snapshot.attempt-1").status,
  "canceled",
);
assert.equal(findFinishEvent(fetchAbortEvents, "input.fetch.snapshot").status, "canceled");

const sectionTreeSchema = JSON.parse(
  await readFile(
    new URL(
      "../04-generate-candidate-analysis/03-create-review-trees/schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const judgeContract = await readFile(
  new URL("../06-judge-candidate/prompt.md", import.meta.url),
  "utf8",
);

assert.match(
  sectionTreeSchema.$defs.reviewSection.properties.explanation.description,
  /why this cohesive chunk matters for the outcome/,
);
assert.match(
  sectionTreeSchema.$defs.reviewSection.properties.explanation.description,
  /Consequence first/,
);
assert.match(
  sectionTreeSchema.$defs.reviewSection.properties.explanation.description,
  /Title-plus/,
);
assert.match(
  sectionTreeSchema.$defs.reviewSection.properties.explanation.description,
  /Reviewer attention:/,
);
assert.ok(sectionTreeSchema.$defs.reviewSection.properties.changedLineRanges);
assert.equal(sectionTreeSchema.$defs.reviewSection.properties.changedLineIds, undefined);
assert.match(
  sectionTreeSchema.$defs.branch.properties.explanation.description,
  /child belongs under the parent/,
);
assert.match(sectionTreeSchema.$defs.branch.properties.explanation.description, /Title-plus/);
assert.match(
  sectionTreeSchema.$defs.file.properties.explanation.description,
  /synthesis of section briefings/,
);
assert.match(sectionTreeSchema.properties.intent.description, /shopper or system outcome/);
assert.match(sectionTreeSchema.properties.summary.description, /consequences and risks/);
assert.match(
  sectionTreeSchema.$defs.reviewSection.properties.title.description,
  /reviewer question/,
);

const sharedContract = await readFile(
  new URL("../04-generate-candidate-analysis/01-shared-contract/prompt.md", import.meta.url),
  "utf8",
);
assert.match(sharedContract, /## Review walk ladders/);
assert.match(sharedContract, /### Stack-split ladder/);
assert.match(sharedContract, /### File-first ladder/);
assert.match(sharedContract, /### Mini-node-first ladder/);
assert.match(sharedContract, /### Titles/);
assert.match(sharedContract, /### Intent and summary/);

const fakeProcessDir = await mkdtemp(path.join(tmpdir(), "prc-cancel-processes-"));
const originalPath = process.env.PATH;

try {
  const descendantProcessSource = `
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
writeFileSync(process.env.PRC_TEST_DESCENDANT_PID_PATH, String(process.pid));
setInterval(() => {}, 1000);
`;
  const fakeProcessSource = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
spawn(
  process.execPath,
  ["-e", ${JSON.stringify(descendantProcessSource)}],
  { stdio: "ignore" },
);
writeFileSync(process.env.PRC_TEST_PROCESS_PID_PATH, String(process.pid));
setInterval(() => {}, 1000);
`;
  const fakeGhPath = path.join(fakeProcessDir, "gh");
  await writeFile(fakeGhPath, fakeProcessSource, "utf8");
  await chmod(fakeGhPath, 0o755);
  process.env.PATH = `${fakeProcessDir}:${originalPath}`;

  const ghPidPath = path.join(fakeProcessDir, "gh.pid");
  const ghDescendantPidPath = path.join(fakeProcessDir, "gh-descendant.pid");
  process.env.PRC_TEST_PROCESS_PID_PATH = ghPidPath;
  process.env.PRC_TEST_DESCENDANT_PID_PATH = ghDescendantPidPath;
  const ghAbortController = new AbortController();
  const ghPromise = ghText(["--version"], {
    signal: ghAbortController.signal,
  });
  const ghPid = Number(await waitForFileText(ghPidPath));
  const ghDescendantPid = Number(await waitForFileText(ghDescendantPidPath));
  ghAbortController.abort(new Error("Stop GitHub fetch."));
  await assert.rejects(
    ghPromise,
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
  );
  assert.equal(
    isProcessAlive(ghPid),
    false,
    "gh cancellation must not settle before the direct process exits",
  );
  assert.equal(
    isProcessAlive(ghDescendantPid),
    false,
    "gh cancellation must terminate descendants in its detached process group",
  );
} finally {
  process.env.PATH = originalPath;
  delete process.env.PRC_TEST_DESCENDANT_PID_PATH;
  delete process.env.PRC_TEST_PROCESS_PID_PATH;
  await rm(fakeProcessDir, { force: true, recursive: true });
}

function assembleCandidate(candidate, reviewStacks) {
  const { fileTree, ...analysis } = candidate;
  return {
    ...analysis,
    schemaVersion: "pr-review-analysis/v1",
    reviewStacks: reviewStacks.map((stack) => ({ ...stack, fileTree })),
  };
}

const diff = `diff --git a/src/example.js b/src/example.js
index 0000000..1111111 100644
--- a/src/example.js
+++ b/src/example.js
@@ -1,2 +1,3 @@
-const value = 1;
+const value = 2;
+validate(value);
 console.log(value);
`;

const multiHunkInventory = createDiffInventory(`diff --git a/src/multi.js b/src/multi.js
index 0000000..1111111 100644
--- a/src/multi.js
+++ b/src/multi.js
@@ -1 +1 @@
-const first = 1;
+const first = 2;
@@ -10 +10 @@
-const second = 1;
+const second = 2;
`);
const multiHunkFile = multiHunkInventory.files[0];
const [firstHunk, secondHunk] = multiHunkFile.hunks;
const multiHunkCandidate = {
  schemaVersion: "pr-review-trees/v1",
  intent: "Update both related constants.",
  summary: "The constants change together.",
  confidence: 1,
  fileTree: { branches: [] },
  files: [
    {
      id: multiHunkFile.id,
      path: multiHunkFile.path,
      reviewPriority: "primary",
      changeKind: "runtime",
      explanation: "Both constants form one runtime contract.",
      sectionTree: {
        sections: [
          {
            id: "update-constants",
            title: "Update related constants",
            reviewPriority: "primary",
            changeKind: "runtime",
            explanation: "The related defaults must move together.",
            changedLineRanges: [
              {
                start: firstHunk.changedLineIds[0],
                end: firstHunk.changedLineIds.at(-1),
              },
              {
                start: secondHunk.changedLineIds[0],
                end: secondHunk.changedLineIds.at(-1),
              },
            ],
          },
        ],
        branches: [],
      },
    },
  ],
};
const materializedMultiHunk = assembleCandidate(
  materializeLineOwnership(multiHunkCandidate, {
    inventory: multiHunkInventory,
  }),
  [
    {
      id: "multi-hunk",
      title: "Related constants",
      explanation: "Both constants belong to one Review Stack.",
      fileIds: [multiHunkFile.id],
    },
  ],
);
validateReviewAnalysis(materializedMultiHunk, {
  inventory: multiHunkInventory,
});
assert.deepEqual(
  materializedMultiHunk.files[0].sectionTree.sections[0].changedLineIds,
  multiHunkFile.changedLineIds,
);
assert.deepEqual(materializedMultiHunk.files[0].changedLineIds, multiHunkFile.changedLineIds);
assert.throws(
  () =>
    materializeLineOwnership(
      {
        ...multiHunkCandidate,
        files: [
          {
            ...multiHunkCandidate.files[0],
            sectionTree: {
              ...multiHunkCandidate.files[0].sectionTree,
              sections: [
                {
                  ...multiHunkCandidate.files[0].sectionTree.sections[0],
                  changedLineRanges: [
                    {
                      start: firstHunk.changedLineIds[0],
                      end: secondHunk.changedLineIds.at(-1),
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      { inventory: multiHunkInventory },
    ),
  /stay within one hunk/,
);

const runDir = await mkdtemp(path.join(tmpdir(), "prc-analysis-pipeline-"));

try {
  const inventory = createDiffInventory(diff);
  const inventoryFile = inventory.files[0];
  const changedLineIds = inventoryFile.changedLineIds;
  const incompleteCandidate = buildCandidate({
    coveredLineIds: changedLineIds.slice(0, -1),
    fileId: inventoryFile.id,
    filePath: inventoryFile.path,
  });
  const validCandidate = buildCandidate({
    coveredLineIds: changedLineIds,
    fileId: inventoryFile.id,
    filePath: inventoryFile.path,
  });
  const calls = [];
  const events = [];
  const executionOptions = [];
  const judgePrompts = [];
  const sectionTreePrompts = [];
  const repairPrompts = [];
  const reviewStacksPrompts = [];
  let judgeAttempt = 0;
  const reviewStacksResult = {
    schemaVersion: "pr-review-stacks/v1",
    reviewStacks: [
      {
        id: "core-change",
        title: "Example value update",
        explanation: "Single cohesive change to the example file.",
        fileIds: [inventoryFile.id],
      },
    ],
  };
  const incompleteCandidateNormalized = assembleCandidate(
    materializeLineOwnership(incompleteCandidate, { inventory }),
    reviewStacksResult.reviewStacks,
  );
  const finalMergedCandidate = {
    ...incompleteCandidateNormalized,
    files: materializeLineOwnership(validCandidate, { inventory }).files,
  };

  await writeRunInputs({
    inventory,
    metadata: { number: 1, title: "Pipeline order" },
    runDir,
  });

  const execute = async ({ model, outputPath, prompt, reasoningEffort, schemaPath }) => {
    executionOptions.push({ model, reasoningEffort });

    if (schemaPath.includes("02-create-review-stacks")) {
      calls.push("review-stacks-1");
      reviewStacksPrompts.push(prompt);
      await writeFile(outputPath, `${JSON.stringify(reviewStacksResult)}\n`, "utf8");
      return {
        usage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 10,
          totalTokens: 110,
        },
      };
    }

    if (schemaPath.includes("06-judge-candidate")) {
      judgeAttempt += 1;
      calls.push(`judge-${judgeAttempt}`);
      judgePrompts.push(prompt);
      const passes = judgeAttempt === 2;
      await writeFile(
        outputPath,
        `${JSON.stringify({
          schemaVersion: "pr-review-judge/v1",
          verdict: passes ? "pass" : "fail",
          confidence: 1,
          summary: passes ? "Candidate is ready." : "Repair the incomplete Section Tree.",
          findings: passes
            ? []
            : [
                {
                  severity: "blocker",
                  type: "validation",
                  targetId: "validate-value",
                  explanation: "The affected file is missing one changed line.",
                },
              ],
        })}\n`,
        "utf8",
      );
      return {
        usage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 10,
          totalTokens: 110,
        },
      };
    }

    assert.match(schemaPath, /03-create-review-trees/);

    if (prompt.includes("# Targeted Section Tree Repair")) {
      calls.push("repair-1");
      repairPrompts.push(prompt);
      await writeFile(outputPath, `${JSON.stringify(validCandidate)}\n`, "utf8");
    } else {
      calls.push("review-trees-1");
      sectionTreePrompts.push(prompt);
      await writeFile(outputPath, `${JSON.stringify(incompleteCandidate)}\n`, "utf8");
    }

    return {
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        totalTokens: 110,
      },
    };
  };

  const result = await runReviewAnalysis({
    execute,
    model: "selected-model",
    onEvent: async (event) => {
      events.push(event);
    },
    reasoningEffort: "xhigh",
    runDir,
  });

  assert.deepEqual(calls, ["review-stacks-1", "review-trees-1", "repair-1"]);
  assert.deepEqual(executionOptions, [
    { model: "selected-model", reasoningEffort: "xhigh" },
    { model: "selected-model", reasoningEffort: "xhigh" },
    { model: "selected-model", reasoningEffort: "xhigh" },
  ]);
  assertStageTimeline(events, [
    "stage-start:analysis",
    "stage-start:analysis.review-stacks",
    "stage-finish:analysis.review-stacks:completed",
    "stage-start:analysis.attempt-1",
    "stage-start:analysis.attempt-1.generate-review-trees",
    "stage-finish:analysis.attempt-1.generate-review-trees:completed",
    "stage-start:analysis.attempt-1.evaluation",
    "stage-start:analysis.attempt-1.evaluation.validate-candidate",
    "stage-finish:analysis.attempt-1.evaluation.validate-candidate:failed",
    "stage-start:analysis.attempt-1.evaluation.judge-candidate",
    "stage-finish:analysis.attempt-1.evaluation.judge-candidate:skipped",
    "stage-finish:analysis.attempt-1.evaluation:failed",
    "stage-finish:analysis.attempt-1:failed",
    "stage-start:analysis.attempt-2",
    "stage-start:analysis.attempt-2.repair-section-trees",
    "stage-finish:analysis.attempt-2.repair-section-trees:completed",
    "stage-start:analysis.attempt-2.evaluation",
    "stage-start:analysis.attempt-2.evaluation.validate-candidate",
    "stage-finish:analysis.attempt-2.evaluation.validate-candidate:completed",
    "stage-start:analysis.attempt-2.evaluation.judge-candidate",
    "stage-finish:analysis.attempt-2.evaluation.judge-candidate:skipped",
    "stage-finish:analysis.attempt-2.evaluation:completed",
    "stage-finish:analysis.attempt-2:completed",
    "stage-start:analysis.persist-artifacts",
    "stage-finish:analysis.persist-artifacts:completed",
    "stage-finish:analysis:completed",
  ]);
  assertStagePairs(events);
  assert.equal(findFinishEvent(events, "analysis.attempt-1").metrics.willRetry, true);
  assert.equal(findFinishEvent(events, "analysis.attempt-2").metrics.willRetry, false);
  assert.equal(
    findFinishEvent(events, "analysis.attempt-1.generate-review-trees").parentStageId,
    "analysis.attempt-1",
  );
  assert.equal(findFinishEvent(events, "analysis.attempt-2").metrics.strategy, "targeted-repair");
  assert.equal(findFinishEvent(events, "analysis.persist-artifacts").parentStageId, "analysis");
  assert.match(
    findFinishEvent(events, "analysis.attempt-1.evaluation.validate-candidate").error,
    /file file-1 sectionTree changedLineIds must exactly match covered diff ids/,
  );
  assert.equal(judgePrompts.length, 0);
  assert.equal(
    findFinishEvent(events, "analysis.attempt-1.evaluation.judge-candidate").metrics.reason,
    "semantic-judge-disabled",
  );
  assert.deepEqual(
    extractJsonTag(repairPrompts[0], "analysis_candidate_json"),
    assembleCandidate(incompleteCandidate, reviewStacksResult.reviewStacks),
  );
  assert.deepEqual(extractJsonTag(repairPrompts[0], "affected_file_ids_json"), [inventoryFile.id]);
  const combinedFeedback = extractJsonTag(repairPrompts[0], "combined_evaluation_feedback_json");
  assert.equal(combinedFeedback.deterministicValidation.status, "fail");
  assert.equal(combinedFeedback.semanticJudge.status, "skipped");
  const affectedDiff = extractJsonTag(repairPrompts[0], "affected_diff_json");
  assert.deepEqual(
    affectedDiff.files.map((file) => file.id),
    [inventoryFile.id],
  );
  assert.match(sectionTreePrompts[0], /<structured_diff_json>/);
  assert.doesNotMatch(sectionTreePrompts[0], /<diff_line_map_json>|<diff_patch>/);
  assert.equal(
    extractJsonTag(sectionTreePrompts[0], "structured_diff_json").schemaVersion,
    "pr-structured-diff/v1",
  );
  assert.match(sectionTreePrompts[0], /## Explanations\n/);
  assert.match(sectionTreePrompts[0], /briefing/);
  assert.match(sectionTreePrompts[0], /Consequence/);
  assert.match(sectionTreePrompts[0], /Title-plus rule/);
  assert.match(sectionTreePrompts[0], /Never open with: "This file/);
  assert.match(sectionTreePrompts[0], /Reviewer attention:/);
  assert.match(sectionTreePrompts[0], /Worked examples/);
  assert.match(sectionTreePrompts[0], /Bad briefing/);
  assert.match(sectionTreePrompts[0], /Good briefing/);
  assert.match(sectionTreePrompts[0], /## Review walk ladders/);
  assert.match(sectionTreePrompts[0], /mini-node-first ladder/);
  assert.match(sectionTreePrompts[0], /file-first ladder/);
  assert.match(sectionTreePrompts[0], /### Titles/);
  assert.match(sectionTreePrompts[0], /Intent and summary/);
  assert.match(sectionTreePrompts[0], /Shape the secondary content variant/);
  assert.match(sectionTreePrompts[0], /Bring in hooks and Pressable symbols/);
  assert.match(reviewStacksPrompts[0], /stack-split ladder/);
  assert.match(sectionTreePrompts[0], /## Cohesive Review Units/);
  assert.match(
    sectionTreePrompts[0],
    /Partition each file into cohesive review units before assigning/,
  );
  assert.match(sectionTreePrompts[0], /Do not emit numeric section depths/);
  assert.match(judgeContract, /stack-split ladder/);
  assert.match(judgeContract, /file-first ladder/);
  assert.match(judgeContract, /## Section cohesion/);
  assert.match(judgeContract, /## Explanations/);
  assert.match(judgeContract, /title-plus/);
  assert.match(judgeContract, /This file/);
  assert.match(judgeContract, /jargon-only/);
  assert.match(judgeContract, /Reviewer attention:/);
  assert.match(judgeContract, /What:` \/ `Why:` labeled output/);
  assert.match(judgeContract, /Do not fail for length or Markdown formatting alone/i);
  assert.match(judgeContract, /imperfect but useful enough to help a reviewer/);
  assert.match(judgeContract, /one contiguous render or JSX phase/);
  assert.deepEqual(result.analysis, finalMergedCandidate);
  assert.deepEqual(result.execution, {
    model: "selected-model",
    reasoningEffort: "xhigh",
  });
  assert.equal(result.judge, null);
  assert.deepEqual(result.usage, {
    inputTokens: 300,
    cachedInputTokens: 60,
    outputTokens: 30,
    totalTokens: 330,
  });
  assert.equal(findFinishEvent(events, "analysis").metrics.totalTokens, 330);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "review-trees.raw.json"), "utf8")),
    incompleteCandidate,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "repair.raw.attempt-2.json"), "utf8")),
    validCandidate,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "analysis.raw.attempt-2.json"), "utf8")),
    finalMergedCandidate,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "analysis.json"), "utf8")),
    finalMergedCandidate,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "review-stacks.json"), "utf8")),
    reviewStacksResult,
  );
  assert.equal(JSON.parse(await readFile(path.join(runDir, "judge.json"), "utf8")), null);
} finally {
  await rm(runDir, { force: true, recursive: true });
}

const canceledRunDir = await mkdtemp(path.join(tmpdir(), "prc-analysis-cancel-"));

try {
  const inventory = createDiffInventory(diff);
  const controller = new AbortController();
  const events = [];
  let executeCalls = 0;

  await writeRunInputs({
    inventory,
    metadata: { number: 3, title: "Cancellation" },
    runDir: canceledRunDir,
  });

  let canceledError;
  await assert.rejects(
    runReviewAnalysis({
      execute: async ({ signal }) => {
        executeCalls += 1;
        assert.equal(signal, controller.signal);
        queueMicrotask(() =>
          controller.abort(new Error("Canceled during section tree generation.")),
        );

        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("Canceled during section tree generation.");
              error.name = "AbortError";
              error.code = "ABORT_ERR";
              error.usage = {
                inputTokens: 17,
                cachedInputTokens: 4,
                outputTokens: 3,
                totalTokens: 20,
              };
              reject(error);
            },
            { once: true },
          );
        });
      },
      onEvent: async (event) => {
        events.push(event);
      },
      runDir: canceledRunDir,
      signal: controller.signal,
    }),
    (error) => {
      canceledError = error;
      return error?.name === "AbortError" && error?.code === "ABORT_ERR";
    },
  );

  assert.equal(executeCalls, 1, "Cancellation must not start another attempt");
  assert.deepEqual(canceledError.usage, {
    inputTokens: 17,
    cachedInputTokens: 4,
    outputTokens: 3,
    totalTokens: 20,
  });
  assert.equal(findFinishEvent(events, "analysis.review-stacks").status, "canceled");
  assert.equal(findFinishEvent(events, "analysis").status, "canceled");
  assert.equal(findFinishEvent(events, "analysis").metrics.totalTokens, 20);
  assertStagePairs(events);
} finally {
  await rm(canceledRunDir, { force: true, recursive: true });
}

const failedRunDir = await mkdtemp(path.join(tmpdir(), "prc-analysis-failure-"));

try {
  const inventory = createDiffInventory(diff);
  const inventoryFile = inventory.files[0];
  const incompleteCandidate = buildCandidate({
    coveredLineIds: inventoryFile.changedLineIds.slice(0, -1),
    fileId: inventoryFile.id,
    filePath: inventoryFile.path,
  });
  const calls = [];
  const events = [];
  let judgeAttempt = 0;
  let repairAttempt = 0;

  await writeRunInputs({
    inventory,
    metadata: { number: 2, title: "No fallback" },
    runDir: failedRunDir,
  });

  const execute = async ({ outputPath, prompt, schemaPath }) => {
    if (schemaPath.includes("02-create-review-stacks")) {
      calls.push("review-stacks-1");
      await writeFile(
        outputPath,
        `${JSON.stringify({
          schemaVersion: "pr-review-stacks/v1",
          reviewStacks: [
            {
              id: "core-change",
              title: "Example value update",
              explanation: "Single cohesive change to the example file.",
              fileIds: [inventoryFile.id],
            },
          ],
        })}\n`,
        "utf8",
      );
      return {
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 1,
          totalTokens: 11,
        },
      };
    }

    if (schemaPath.includes("03-create-review-trees")) {
      if (prompt.includes("# Targeted Section Tree Repair")) {
        repairAttempt += 1;
        calls.push(`repair-${repairAttempt}`);
      } else {
        calls.push("review-trees-1");
      }
      await writeFile(outputPath, `${JSON.stringify(incompleteCandidate)}\n`, "utf8");
      return {
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 1,
          totalTokens: 11,
        },
      };
    }

    judgeAttempt += 1;
    calls.push(`judge-${judgeAttempt}`);
    await writeFile(
      outputPath,
      `${JSON.stringify({
        schemaVersion: "pr-review-judge/v1",
        verdict: "fail",
        confidence: 1,
        summary: "Coverage remains incomplete.",
        findings: [
          {
            severity: "blocker",
            type: "validation",
            targetId: "validate-value",
            explanation: "Do not accept or replace this with a fallback tree.",
          },
        ],
      })}\n`,
      "utf8",
    );
    return {
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 1,
        totalTokens: 11,
      },
    };
  };

  let terminalError;
  await assert.rejects(
    runReviewAnalysis({
      execute,
      onEvent: async (event) => {
        events.push(event);
      },
      runDir: failedRunDir,
    }),
    (error) => {
      terminalError = error;
      return /PR review tree analysis failed after 3 complete attempts/.test(error.message);
    },
  );
  assert.deepEqual(calls, ["review-stacks-1", "review-trees-1", "repair-1", "repair-2"]);
  assert.deepEqual(terminalError.usage, {
    inputTokens: 40,
    cachedInputTokens: 8,
    outputTokens: 4,
    totalTokens: 44,
  });
  assertStagePairs(events);
  assert.equal(findFinishEvent(events, "analysis").status, "failed");
  assert.match(findFinishEvent(events, "analysis").error, /failed after 3 complete attempts/);
  assert.equal(findFinishEvent(events, "analysis").metrics.totalTokens, 44);
  assert.equal(
    events.some((event) => event.stageId === "analysis.persist-artifacts"),
    false,
  );

  for (let failedAttempt = 1; failedAttempt <= 3; failedAttempt += 1) {
    const stageId = `analysis.attempt-${failedAttempt}`;
    const attemptFinish = findFinishEvent(events, stageId);

    assert.equal(attemptFinish.status, "failed");
    assert.equal(attemptFinish.metrics.willRetry, failedAttempt < 3);
    assert.equal(
      findFinishEvent(events, `${stageId}.evaluation.validate-candidate`).status,
      "failed",
    );
    assert.equal(
      findFinishEvent(events, `${stageId}.evaluation.judge-candidate`).status,
      "skipped",
    );
  }
  await assert.rejects(
    readFile(path.join(failedRunDir, "analysis.json"), "utf8"),
    (error) => error?.code === "ENOENT",
  );
} finally {
  await rm(failedRunDir, { force: true, recursive: true });
}

// A single Review Stack exceeds the per-call file cap, so this proves that it is
// sharded and joined into one complete File Tree.
const shardedDiff = Array.from({ length: 16 }, (_, index) => {
  const name = `file-${String(index + 1).padStart(2, "0")}`;
  return `diff --git a/src/${name}.js b/src/${name}.js
index 0000000..1111111 100644
--- a/src/${name}.js
+++ b/src/${name}.js
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`;
}).join("");
const shardedRunDir = await mkdtemp(path.join(tmpdir(), "prc-analysis-sharded-"));

try {
  const inventory = createDiffInventory(shardedDiff);
  const stackAFiles = inventory.files;
  const stackA = {
    id: "stack-a",
    title: "Stack A",
    explanation: "The oversized change.",
    fileIds: stackAFiles.map((file) => file.id),
  };
  const shardedReviewStacks = {
    schemaVersion: "pr-review-stacks/v1",
    reviewStacks: [stackA],
  };
  const fullStackATree = {
    branches: stackA.fileIds.slice(1).map((fileId, order) => ({
      parentId: stackA.fileIds[0],
      childId: fileId,
      order,
      explanation:
        "Supporting files carry the same constant change after the root establishes the shard behavior.",
    })),
  };
  const calls = [];

  await writeRunInputs({
    inventory,
    metadata: { number: 4, title: "Sharded review trees" },
    runDir: shardedRunDir,
  });

  const buildShardCandidate = (files) => ({
    schemaVersion: "pr-review-trees/v1",
    intent: "Review the sharded change.",
    summary: "Several related files change.",
    confidence: 1,
    fileTree: {
      branches: files.slice(1).map((file, order) => ({
        parentId: files[0].id,
        childId: file.id,
        order,
        explanation: "Supporting files implement the shard after the root constant changes.",
      })),
    },
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      reviewPriority: "primary",
      changeKind: "runtime",
      explanation: "Each shard file updates one constant that feeds the shared runtime contract.",
      sectionTree: {
        sections: [
          {
            id: "change-constant",
            title: "Change the constant",
            reviewPriority: "primary",
            changeKind: "runtime",
            explanation: "Downstream callers read this constant at runtime.",
            changedLineRanges: toRanges(file.changedLineIds),
          },
        ],
        branches: [],
      },
    })),
  });

  const execute = async ({ outputPath, prompt, schemaPath }) => {
    if (schemaPath.includes("02-create-review-stacks")) {
      calls.push("review-stacks-1");
      await writeFile(outputPath, `${JSON.stringify(shardedReviewStacks)}\n`, "utf8");
      return { usage: {} };
    }

    if (schemaPath.endsWith("file-tree.schema.json")) {
      calls.push("file-tree-a");
      assert.deepEqual(
        extractJsonTag(prompt, "files_json").map((file) => file.id),
        stackA.fileIds,
      );
      await writeFile(outputPath, `${JSON.stringify(fullStackATree)}\n`, "utf8");
      return { usage: {} };
    }

    assert.match(schemaPath, /03-create-review-trees/);
    const inputFileIds = extractJsonTag(prompt, "structured_diff_json").files.map(
      (file) => file.id,
    );
    const inputFiles = inputFileIds.map((fileId) =>
      inventory.files.find((file) => file.id === fileId),
    );

    if (prompt.includes(`"${stackA.title}" review stack`)) {
      calls.push(`review-trees-a-${inputFiles.length}`);
      await writeFile(outputPath, `${JSON.stringify(buildShardCandidate(inputFiles))}\n`, "utf8");
    } else {
      assert.fail("Review tree shard prompt did not name its Review Stack.");
    }

    return { usage: {} };
  };

  const shardedEvents = [];
  const result = await runReviewAnalysis({
    execute,
    model: "selected-model",
    onEvent: async (event) => {
      shardedEvents.push(event);
    },
    reasoningEffort: "xhigh",
    runDir: shardedRunDir,
  });

  assert.deepEqual(calls.sort(), [
    "file-tree-a",
    "review-stacks-1",
    "review-trees-a-1",
    "review-trees-a-15",
  ]);
  assert.deepEqual(
    result.analysis.files.map((file) => file.id).sort(),
    inventory.files.map((file) => file.id).sort(),
  );
  assert.deepEqual(
    result.analysis.reviewStacks.find((stack) => stack.id === stackA.id)?.fileTree,
    fullStackATree,
  );
  validateReviewAnalysis(result.analysis, { inventory });
  const shardedAnalysisMetrics = findFinishEvent(shardedEvents, "analysis").metrics;
  assert.equal(shardedAnalysisMetrics.invalidFileTreeRootCount, 0);
  assert.equal(shardedAnalysisMetrics.fileTreeDepth, 1);
  assert.equal(shardedAnalysisMetrics.sourceOrderMatch, 1);
} finally {
  await rm(shardedRunDir, { force: true, recursive: true });
}

const failingShardDiff = Array.from({ length: 4 }, (_, index) => {
  const name = `failure-${index + 1}`;
  return `diff --git a/src/${name}.js b/src/${name}.js
index 0000000..1111111 100644
--- a/src/${name}.js
+++ b/src/${name}.js
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`;
}).join("");
const failingShardRunDir = await mkdtemp(path.join(tmpdir(), "prc-analysis-shard-failure-"));

try {
  const inventory = createDiffInventory(failingShardDiff);
  const reviewStacks = {
    schemaVersion: "pr-review-stacks/v1",
    reviewStacks: inventory.files.map((file, index) => ({
      id: `stack-${index + 1}`,
      title: `Stack ${index + 1}`,
      explanation: `Shard ${index + 1} covers one changed file so reviewers can inspect it without cross-file noise.`,
      fileIds: [file.id],
    })),
  };
  const attemptStates = new Map();
  let maximumActiveCalls = 0;

  await writeRunInputs({
    inventory,
    metadata: { number: 5, title: "Fail one review-tree shard" },
    runDir: failingShardRunDir,
  });

  await assert.rejects(
    runReviewAnalysis({
      execute: async ({ outputPath, prompt, schemaPath, signal }) => {
        if (schemaPath.includes("02-create-review-stacks")) {
          await writeFile(outputPath, `${JSON.stringify(reviewStacks)}\n`, "utf8");
          return { usage: {} };
        }

        const attempt = outputPath.includes(".attempt-3.")
          ? 3
          : outputPath.includes(".attempt-2.")
            ? 2
            : 1;
        let state = attemptStates.get(attempt);
        if (!state) {
          let releaseStarted;
          state = {
            aborted: 0,
            active: 0,
            settled: 0,
            started: 0,
            startedThree: new Promise((resolve) => {
              releaseStarted = resolve;
            }),
            releaseStarted,
          };
          attemptStates.set(attempt, state);
        }

        state.active += 1;
        state.started += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, state.active);
        if (state.started === 3) {
          state.releaseStarted();
        }

        try {
          await state.startedThree;
          if (prompt.includes('"Stack 1" review stack')) {
            throw new Error(`Shard attempt ${attempt} failed.`);
          }

          await new Promise((_, reject) => {
            const onAbort = () => {
              state.aborted += 1;
              const error = new Error("Sibling shard was aborted.");
              error.name = "AbortError";
              error.code = "ABORT_ERR";
              reject(error);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
              onAbort();
            }
          });
        } finally {
          state.active -= 1;
          state.settled += 1;
        }
      },
      runDir: failingShardRunDir,
    }),
    /failed after 3 complete attempts/,
  );

  assert.equal(maximumActiveCalls, 3);
  assert.deepEqual(
    [...attemptStates.values()].map(({ aborted, active, settled, started }) => ({
      aborted,
      active,
      settled,
      started,
    })),
    Array.from({ length: 3 }, () => ({
      aborted: 2,
      active: 0,
      settled: 3,
      started: 3,
    })),
  );
} finally {
  await rm(failingShardRunDir, { force: true, recursive: true });
}

function assertStageTimeline(events, expected) {
  assert.deepEqual(
    events.map((event) => [event.type, event.stageId, event.status].filter(Boolean).join(":")),
    expected,
  );
}

function assertStagePairs(events) {
  const stageEvents = new Map();

  for (const event of events) {
    assert.equal(Number.isNaN(Date.parse(event.at)), false);

    const eventsForStage = stageEvents.get(event.stageId) || [];
    eventsForStage.push(event);
    stageEvents.set(event.stageId, eventsForStage);

    if (event.type === "stage-finish") {
      assert.ok(
        event.status === "completed" ||
          event.status === "failed" ||
          event.status === "canceled" ||
          event.status === "skipped",
      );
      assert.equal(typeof event.metrics.elapsedMs, "number");
      assert.ok(event.metrics.elapsedMs >= 0);
    }
  }

  for (const [stageId, eventsForStage] of stageEvents) {
    assert.equal(eventsForStage.length, 2, `${stageId} must emit exactly two events`);
    assert.equal(eventsForStage[0].type, "stage-start");
    assert.equal(eventsForStage[1].type, "stage-finish");
  }
}

function findFinishEvent(events, stageId) {
  const event = events.find(
    (candidate) => candidate.type === "stage-finish" && candidate.stageId === stageId,
  );

  assert.ok(event, `Expected a finish event for ${stageId}`);
  return event;
}

async function waitForFileText(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for ${filePath}.`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function buildCandidate({ coveredLineIds, fileId, filePath }) {
  const rootLineIds = coveredLineIds.slice(0, 2);
  const supportingLineIds = coveredLineIds.slice(2);
  const sections = [
    {
      id: "change-value",
      title: "Change the value",
      reviewPriority: "primary",
      changeKind: "runtime",
      explanation: "Callers depend on the example value being 2 instead of 1.",
      changedLineRanges: toRanges(rootLineIds),
    },
  ];
  const branches = [];

  if (supportingLineIds.length > 0) {
    sections.push({
      id: "validate-value",
      title: "Validate the value",
      reviewPriority: "secondary",
      changeKind: "runtime",
      explanation: "Validation is required by the changed runtime value.",
      changedLineRanges: toRanges(supportingLineIds),
    });
    branches.push({
      parentId: "change-value",
      childId: "validate-value",
      order: 0,
      explanation: "Changing the value requires validating it.",
    });
  }

  return {
    schemaVersion: "pr-review-trees/v1",
    intent: "Review the example change",
    summary: "Update and validate the example value.",
    confidence: 1,
    fileTree: { branches: [] },
    files: [
      {
        id: fileId,
        path: filePath,
        reviewPriority: "primary",
        changeKind: "runtime",
        explanation: "Runtime behavior now validates the updated example value before logging it.",
        sectionTree: {
          sections,
          branches,
        },
      },
    ],
  };
}

function toRanges(lineIds) {
  return lineIds.length === 0 ? [] : [{ start: lineIds[0], end: lineIds.at(-1) }];
}

async function writeRunInputs({ inventory, metadata, runDir }) {
  await Promise.all([
    writeFile(path.join(runDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8"),
    writeFile(path.join(runDir, "diff.patch"), diff, "utf8"),
    writeFile(path.join(runDir, "diff-inventory.json"), `${JSON.stringify(inventory)}\n`, "utf8"),
  ]);
}

function extractJsonTag(text, tagName) {
  const match = text.match(new RegExp(`<${tagName}>\\n([\\s\\S]*?)\\n</${tagName}>`));
  assert.ok(match, `Missing <${tagName}> block.`);
  return JSON.parse(match[1]);
}

function buildPrMetadata({ baseSha, headSha }) {
  return {
    additions: 12,
    baseRefName: "main",
    baseRefOid: baseSha,
    changedFiles: 2,
    deletions: 3,
    files: [{ path: "src/index.js" }, { path: "src/test.js" }],
    headRefName: "feature",
    headRefOid: headSha,
    number: 42,
    title: "Keep the snapshot consistent",
    url: snapshotPrUrl,
  };
}

function createFakeGh({ calls, diffs, metadata }) {
  return async (args) => {
    calls.push(args);

    if (args[0] === "--version") {
      return "gh version test";
    }
    if (args[0] === "auth" && args[1] === "status") {
      return "authenticated";
    }
    if (args[0] === "pr" && args[1] === "view") {
      const response = metadata.shift();
      assert.ok(response, "Unexpected extra metadata request");
      return JSON.stringify(response);
    }
    if (args[0] === "pr" && args[1] === "diff") {
      const response = diffs.shift();
      assert.notEqual(response, undefined, "Unexpected extra diff request");
      return response;
    }

    assert.fail(`Unexpected gh invocation: ${args.join(" ")}`);
  };
}
