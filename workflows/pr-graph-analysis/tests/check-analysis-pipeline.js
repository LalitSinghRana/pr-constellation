import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fetchPullRequest,
  ghText,
  parseGitHubPrUrl,
} from "../02-fetch-pr/github.js";
import { createDiffInventory } from "../03-build-diff-inventory/diff-inventory.js";
import {
  buildCodexExecArgs,
  materializeLineOwnership,
  parseCodexJsonUsage,
  resolveCodexExecutionConfig,
  runCodexExec,
  runCodexGraphAnalysis,
  validateMiniTreeAnalysis,
} from "../07-run-retry-loop/codex-agent.js";

const parsedPr = parseGitHubPrUrl(
  "https://github.com/PicnicSupermarket/picnic-store-config/pull/4812",
);
assert.deepEqual(parsedPr, {
  owner: "PicnicSupermarket",
  repo: "picnic-store-config",
  number: "4812",
  slug: "gh-17-picnicsupermarket-19-picnic-store-config-4812",
});
assert.notEqual(
  parsedPr.slug,
  parseGitHubPrUrl(
    "https://github.com/AnotherOwner/picnic-store-config/pull/4812",
  ).slug,
);
assert.notEqual(
  parseGitHubPrUrl("https://github.com/a-b/c/pull/1").slug,
  parseGitHubPrUrl("https://github.com/a/b-c/pull/1").slug,
);
assert.equal(
  parseGitHubPrUrl(
    "https://github.com/PICNICSUPERMARKET/PICNIC-STORE-CONFIG/pull/4812",
  ).slug,
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
assert.equal(
  snapshotCalls.filter((args) => args[0] === "pr" && args[1] === "diff").length,
  2,
);
assertStagePairs(snapshotEvents);
assert.equal(
  findFinishEvent(snapshotEvents, "input.fetch.snapshot").metrics.attempts,
  2,
);
assert.equal(
  findFinishEvent(snapshotEvents, "input.fetch.snapshot.attempt-1").status,
  "failed",
);
assert.equal(
  findFinishEvent(snapshotEvents, "input.fetch.snapshot.attempt-1").metrics.willRetry,
  true,
);
assert.equal(
  findFinishEvent(
    snapshotEvents,
    "input.fetch.snapshot.attempt-1.verify-refs",
  ).metrics.snapshotConsistent,
  false,
);
assert.equal(
  findFinishEvent(snapshotEvents, "input.fetch.snapshot.attempt-2").status,
  "completed",
);
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
  movingSnapshotCalls.filter(
    (args) => args[0] === "pr" && args[1] === "diff",
  ).length,
  3,
);
assertStagePairs(movingSnapshotEvents);
assert.equal(
  findFinishEvent(
    movingSnapshotEvents,
    "input.fetch.snapshot.attempt-3",
  ).metrics.willRetry,
  false,
);
assert.equal(
  findFinishEvent(movingSnapshotEvents, "input.fetch.snapshot").status,
  "failed",
);

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
        queueMicrotask(() => fetchAbortController.abort(
          new Error("Canceled while fetching the PR diff."),
        ));
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("Canceled while fetching the PR diff.");
            error.name = "AbortError";
            error.code = "ABORT_ERR";
            reject(error);
          }, { once: true });
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
assert.equal(
  findFinishEvent(fetchAbortEvents, "input.fetch.snapshot").status,
  "canceled",
);

const miniTreeSchema = JSON.parse(
  await readFile(
    new URL(
      "../04-generate-candidate-analysis/02-create-mini-trees/schema.json",
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
  miniTreeSchema.$defs.miniNode.properties.comment.description,
  /What this cohesive code section changes or proves and why/,
);
assert.ok(miniTreeSchema.$defs.miniNode.properties.changedLineRanges);
assert.equal(
  miniTreeSchema.$defs.miniNode.properties.changedLineIds,
  undefined,
);
assert.equal(miniTreeSchema.$defs.file.properties.codeRefs, undefined);
assert.match(
  miniTreeSchema.$defs.reviewEdge.properties.comment.description,
  /why the target belongs next/,
);
assert.match(
  miniTreeSchema.$defs.reviewEdge.properties.comment.description,
  /Prefer concise Markdown prose/,
);

assert.deepEqual(
  resolveCodexExecutionConfig({
    env: {
      PRC_CODEX_MODEL: "env-model",
      PRC_CODEX_REASONING_EFFORT: "medium",
    },
  }),
  {
    model: "env-model",
    reasoningEffort: "medium",
  },
);
assert.deepEqual(
  resolveCodexExecutionConfig({
    env: {
      PRC_CODEX_MODEL: "env-model",
      PRC_CODEX_REASONING_EFFORT: "medium",
    },
    model: "selected-model",
    reasoningEffort: "high",
  }),
  {
    model: "selected-model",
    reasoningEffort: "high",
  },
);
assert.throws(
  () => resolveCodexExecutionConfig({ model: 123 }),
  /model must be a string/,
);

const codexArgs = buildCodexExecArgs({
  cwd: "/tmp/review",
  model: "selected-model",
  outputPath: "/tmp/output.json",
  reasoningEffort: "high",
  schemaPath: "/tmp/schema.json",
});
assert.ok(codexArgs.includes("--json"));
assert.deepEqual(
  codexArgs.slice(codexArgs.indexOf("--model"), codexArgs.indexOf("--model") + 2),
  ["--model", "selected-model"],
);
assert.deepEqual(
  codexArgs.slice(codexArgs.indexOf("--config"), codexArgs.indexOf("--config") + 2),
  ["--config", 'model_reasoning_effort="high"'],
);
assert.deepEqual(
  parseCodexJsonUsage([
    '{"type":"thread.started","thread_id":"thread-1"}',
    '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":80,"output_tokens":30,"reasoning_output_tokens":10}}',
    "not-json",
    '{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":5,"output_tokens":4,"reasoning_output_tokens":1}}',
  ].join("\n")),
  {
    inputTokens: 140,
    cachedInputTokens: 85,
    outputTokens: 34,
    totalTokens: 174,
  },
);

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
if (process.env.PRC_TEST_EMIT_USAGE === "1") {
  process.stdout.write(
    '{"type":"turn.completed","usage":{"input_tokens":9,"cached_input_tokens":3,"output_tokens":2}}\\n',
  );
}
setInterval(() => {}, 1000);
`;
  const fakeGhPath = path.join(fakeProcessDir, "gh");
  const fakeCodexPath = path.join(fakeProcessDir, "codex");
  await Promise.all([
    writeFile(fakeGhPath, fakeProcessSource, "utf8"),
    writeFile(fakeCodexPath, fakeProcessSource, "utf8"),
  ]);
  await Promise.all([
    chmod(fakeGhPath, 0o755),
    chmod(fakeCodexPath, 0o755),
  ]);
  process.env.PATH = `${fakeProcessDir}:${originalPath}`;

  const ghPidPath = path.join(fakeProcessDir, "gh.pid");
  const ghDescendantPidPath = path.join(fakeProcessDir, "gh-descendant.pid");
  process.env.PRC_TEST_PROCESS_PID_PATH = ghPidPath;
  process.env.PRC_TEST_DESCENDANT_PID_PATH = ghDescendantPidPath;
  delete process.env.PRC_TEST_EMIT_USAGE;
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

  const codexPidPath = path.join(fakeProcessDir, "codex.pid");
  const codexDescendantPidPath = path.join(
    fakeProcessDir,
    "codex-descendant.pid",
  );
  process.env.PRC_TEST_PROCESS_PID_PATH = codexPidPath;
  process.env.PRC_TEST_DESCENDANT_PID_PATH = codexDescendantPidPath;
  process.env.PRC_TEST_EMIT_USAGE = "1";
  const codexAbortController = new AbortController();
  const codexPromise = runCodexExec({
    cwd: fakeProcessDir,
    outputPath: path.join(fakeProcessDir, "unused-output.json"),
    prompt: "Analyze this PR.",
    schemaPath: path.join(fakeProcessDir, "unused-schema.json"),
    signal: codexAbortController.signal,
  });
  const codexPid = Number(await waitForFileText(codexPidPath));
  const codexDescendantPid = Number(
    await waitForFileText(codexDescendantPidPath),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  codexAbortController.abort(new Error("Stop Codex analysis."));
  let codexAbortError;
  await assert.rejects(
    codexPromise,
    (error) => {
      codexAbortError = error;
      return error?.name === "AbortError" && error?.code === "ABORT_ERR";
    },
  );
  assert.deepEqual(codexAbortError.usage, {
    inputTokens: 9,
    cachedInputTokens: 3,
    outputTokens: 2,
    totalTokens: 11,
  });
  assert.equal(
    isProcessAlive(codexPid),
    false,
    "Codex cancellation must not settle before the direct process exits",
  );
  assert.equal(
    isProcessAlive(codexDescendantPid),
    false,
    "Codex cancellation must terminate descendants in its detached process group",
  );
} finally {
  process.env.PATH = originalPath;
  delete process.env.PRC_TEST_DESCENDANT_PID_PATH;
  delete process.env.PRC_TEST_EMIT_USAGE;
  delete process.env.PRC_TEST_PROCESS_PID_PATH;
  await rm(fakeProcessDir, { force: true, recursive: true });
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
  schemaVersion: "pr-graph-mini-trees/v2",
  intent: "Update both related constants.",
  summary: "The constants change together.",
  confidence: 1,
  fileFlow: { edges: [] },
  files: [{
    id: multiHunkFile.id,
    path: multiHunkFile.path,
    reviewClass: "important",
    changeRole: "runtime",
    comment: "Both constants form one runtime contract.",
    miniTree: {
      nodes: [{
        id: "update-constants",
        title: "Update related constants",
        reviewClass: "important",
        changeRole: "runtime",
        comment: "The related defaults must move together.",
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
      }],
      reviewEdges: [],
      relations: [],
    },
  }],
};
const materializedMultiHunk = materializeLineOwnership(multiHunkCandidate, {
  inventory: multiHunkInventory,
});
validateMiniTreeAnalysis(materializedMultiHunk, {
  inventory: multiHunkInventory,
});
assert.deepEqual(
  materializedMultiHunk.files[0].miniTree.nodes[0].changedLineIds,
  multiHunkFile.changedLineIds,
);
assert.deepEqual(
  materializedMultiHunk.files[0].codeRefs.changedLineIds,
  multiHunkFile.changedLineIds,
);
assert.throws(
  () => materializeLineOwnership({
    ...multiHunkCandidate,
    files: [{
      ...multiHunkCandidate.files[0],
      miniTree: {
        ...multiHunkCandidate.files[0].miniTree,
        nodes: [{
          ...multiHunkCandidate.files[0].miniTree.nodes[0],
          changedLineRanges: [{
            start: firstHunk.changedLineIds[0],
            end: secondHunk.changedLineIds.at(-1),
          }],
        }],
      },
    }],
  }, { inventory: multiHunkInventory }),
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
  const stackId = "core-change";
  // codex-agent.js normalizes a single-stack generation's top-level `fileFlow` into
  // `fileFlows` keyed by stack id, and a repair attempt inherits `fileFlows` from the
  // prior candidate rather than the repair call's own (discarded) fileFlow.
  const incompleteCandidateNormalized = withFileFlows(incompleteCandidate, stackId);
  const materializedValidCandidate = materializeLineOwnership(validCandidate, {
    inventory,
  });
  // The final merged candidate keeps attempt 1's fileFlows (derived from
  // incompleteCandidate) and attempt 2 repair's files (from validCandidate) — repair
  // never re-emits fileFlow, so mergeTargetedRepair's spread carries the old one forward.
  const { fileFlow: _unusedValidFileFlow, ...materializedValidCandidateFields } = materializedValidCandidate;
  const finalMergedCandidate = {
    ...materializedValidCandidateFields,
    fileFlows: { [stackId]: incompleteCandidate.fileFlow },
  };
  const calls = [];
  const events = [];
  const executionOptions = [];
  const judgePrompts = [];
  const miniPrompts = [];
  const repairPrompts = [];
  const reviewStackPrompts = [];
  let judgeAttempt = 0;
  const reviewStackResult = {
    schemaVersion: "pr-graph-review-stack/v1",
    stacks: [{
      id: "core-change",
      title: "Example value update",
      comment: "Single cohesive change to the example file.",
      fileIds: [inventoryFile.id],
    }],
  };

  await writeRunInputs({
    inventory,
    metadata: { number: 1, title: "Pipeline order" },
    runDir,
  });

  const executeCodex = async ({
    model,
    outputPath,
    prompt,
    reasoningEffort,
    schemaPath,
  }) => {
    executionOptions.push({ model, reasoningEffort });

    if (schemaPath.includes("03-create-review-stack")) {
      calls.push("review-stack-1");
      reviewStackPrompts.push(prompt);
      await writeFile(outputPath, `${JSON.stringify(reviewStackResult)}\n`, "utf8");
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
          schemaVersion: "pr-graph-judge/v1",
          verdict: passes ? "pass" : "fail",
          confidence: 1,
          summary: passes
            ? "Candidate is ready."
            : "Repair the incomplete file mini-tree.",
          findings: passes
            ? []
            : [{
                severity: "blocker",
                type: "validation",
                targetId: "validate-value",
                comment: "The affected file is missing one changed line.",
              }],
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

    assert.match(schemaPath, /02-create-mini-trees/);

    if (prompt.includes("# Targeted PR Mini-Tree Repair")) {
      calls.push("repair-1");
      repairPrompts.push(prompt);
      await writeFile(outputPath, `${JSON.stringify(validCandidate)}\n`, "utf8");
    } else {
      calls.push("mini-1");
      miniPrompts.push(prompt);
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

  const result = await runCodexGraphAnalysis({
    executeCodex,
    model: "selected-model",
    onEvent: async (event) => {
      events.push(event);
    },
    reasoningEffort: "xhigh",
    runDir,
  });

  assert.deepEqual(calls, ["review-stack-1", "mini-1", "repair-1"]);
  assert.deepEqual(
    executionOptions,
    [
      { model: "selected-model", reasoningEffort: "xhigh" },
      { model: "selected-model", reasoningEffort: "xhigh" },
      { model: "selected-model", reasoningEffort: "xhigh" },
    ],
  );
  assertStageTimeline(events, [
    "stage-start:analysis",
    "stage-start:analysis.review-stack",
    "stage-finish:analysis.review-stack:completed",
    "stage-start:analysis.attempt-1",
    "stage-start:analysis.attempt-1.generate-mini-trees",
    "stage-finish:analysis.attempt-1.generate-mini-trees:completed",
    "stage-start:analysis.attempt-1.evaluation",
    "stage-start:analysis.attempt-1.evaluation.validate-candidate",
    "stage-finish:analysis.attempt-1.evaluation.validate-candidate:failed",
    "stage-start:analysis.attempt-1.evaluation.judge-candidate",
    "stage-finish:analysis.attempt-1.evaluation.judge-candidate:skipped",
    "stage-finish:analysis.attempt-1.evaluation:failed",
    "stage-finish:analysis.attempt-1:failed",
    "stage-start:analysis.attempt-2",
    "stage-start:analysis.attempt-2.repair-mini-trees",
    "stage-finish:analysis.attempt-2.repair-mini-trees:completed",
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
    findFinishEvent(events, "analysis.attempt-1.generate-mini-trees").parentStageId,
    "analysis.attempt-1",
  );
  assert.equal(
    findFinishEvent(events, "analysis.attempt-2").metrics.strategy,
    "targeted-repair",
  );
  assert.equal(
    findFinishEvent(events, "analysis.persist-artifacts").parentStageId,
    "analysis",
  );
  assert.match(
    findFinishEvent(
      events,
      "analysis.attempt-1.evaluation.validate-candidate",
    ).error,
    /miniTree changedLineIds must exactly match covered diff ids/,
  );
  assert.equal(judgePrompts.length, 0);
  assert.equal(
    findFinishEvent(
      events,
      "analysis.attempt-1.evaluation.judge-candidate",
    ).metrics.reason,
    "semantic-judge-disabled",
  );
  assert.deepEqual(
    extractJsonTag(repairPrompts[0], "analysis_candidate_json"),
    incompleteCandidateNormalized,
  );
  assert.deepEqual(
    extractJsonTag(repairPrompts[0], "affected_file_ids_json"),
    [inventoryFile.id],
  );
  const combinedFeedback = extractJsonTag(
    repairPrompts[0],
    "combined_evaluation_feedback_json",
  );
  assert.equal(combinedFeedback.deterministicValidation.status, "fail");
  assert.equal(combinedFeedback.semanticJudge.status, "skipped");
  const affectedDiff = extractJsonTag(repairPrompts[0], "affected_diff_json");
  assert.deepEqual(
    affectedDiff.files.map((file) => file.id),
    [inventoryFile.id],
  );
  assert.match(miniPrompts[0], /<structured_diff_json>/);
  assert.doesNotMatch(miniPrompts[0], /<diff_line_map_json>|<diff_patch>/);
  assert.equal(
    extractJsonTag(
      miniPrompts[0],
      "structured_diff_json",
    ).schemaVersion,
    "pr-graph-structured-diff/v1",
  );
  assert.match(miniPrompts[0], /## Explanation Comments: What And Why/);
  assert.match(
    miniPrompts[0],
    /code attached to a mini-node already tells the reviewer \*\*how\*\*/,
  );
  assert.match(miniPrompts[0], /use Markdown bullet points inside the/);
  assert.match(
    miniPrompts[0],
    /Length and Markdown formatting are advisory/,
  );
  assert.match(
    miniPrompts[0],
    /never treat\s+formatting alone as a quality failure/i,
  );
  assert.match(miniPrompts[0], /## Cohesive Review Units/);
  assert.match(
    miniPrompts[0],
    /Partition each file into cohesive review units before assigning/,
  );
  assert.match(miniPrompts[0], /Do not emit numeric node depths/);
  assert.match(judgeContract, /## Mandatory Section-Cohesion Audit/);
  assert.match(judgeContract, /## Mandatory Comment Audit/);
  assert.match(
    judgeContract,
    /attached code answers \*\*how\*\* the implementation works/,
  );
  assert.match(
    judgeContract,
    /Length and Markdown formatting are advisory/,
  );
  assert.match(judgeContract, /never fail a useful comment solely/);
  assert.match(
    judgeContract,
    /contiguous JSX\/render phase split into separate loading/,
  );
  assert.deepEqual(result.analysis, {
    ...finalMergedCandidate,
    reviewStack: reviewStackResult,
  });
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
    JSON.parse(await readFile(path.join(runDir, "mini-trees.raw.json"), "utf8")),
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
    { ...finalMergedCandidate, reviewStack: reviewStackResult },
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "review-stack.json"), "utf8")),
    reviewStackResult,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(runDir, "judge.json"), "utf8")),
    null,
  );
  await assert.rejects(
    readFile(path.join(runDir, "middle-trees.raw.json"), "utf8"),
    (error) => error?.code === "ENOENT",
  );
  await assert.rejects(
    readFile(path.join(runDir, "super-tree.raw.json"), "utf8"),
    (error) => error?.code === "ENOENT",
  );
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
    runCodexGraphAnalysis({
      executeCodex: async ({ signal }) => {
        executeCalls += 1;
        assert.equal(signal, controller.signal);
        queueMicrotask(() => controller.abort(
          new Error("Canceled during mini-tree generation."),
        ));

        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("Canceled during mini-tree generation.");
            error.name = "AbortError";
            error.code = "ABORT_ERR";
            error.usage = {
              inputTokens: 17,
              cachedInputTokens: 4,
              outputTokens: 3,
              totalTokens: 20,
            };
            reject(error);
          }, { once: true });
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
  assert.equal(
    findFinishEvent(events, "analysis.review-stack").status,
    "canceled",
  );
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

  const executeCodex = async ({ outputPath, prompt, schemaPath }) => {
    if (schemaPath.includes("03-create-review-stack")) {
      calls.push("review-stack-1");
      await writeFile(
        outputPath,
        `${JSON.stringify({
          schemaVersion: "pr-graph-review-stack/v1",
          stacks: [{
            id: "core-change",
            title: "Example value update",
            comment: "Single cohesive change to the example file.",
            fileIds: [inventoryFile.id],
          }],
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

    if (schemaPath.includes("02-create-mini-trees")) {
      if (prompt.includes("# Targeted PR Mini-Tree Repair")) {
        repairAttempt += 1;
        calls.push(`repair-${repairAttempt}`);
      } else {
        calls.push("mini-1");
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
        schemaVersion: "pr-graph-judge/v1",
        verdict: "fail",
        confidence: 1,
        summary: "Coverage remains incomplete.",
        findings: [{
          severity: "blocker",
          type: "validation",
          targetId: "validate-value",
          comment: "Do not accept or replace this with a fallback tree.",
        }],
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
    runCodexGraphAnalysis({
      executeCodex,
      onEvent: async (event) => {
        events.push(event);
      },
      runDir: failedRunDir,
    }),
    (error) => {
      terminalError = error;
      return /PR mini-tree analysis failed after 3 complete attempts/.test(
        error.message,
      );
    },
  );
  assert.deepEqual(calls, [
    "review-stack-1",
    "mini-1",
    "repair-1",
    "repair-2",
  ]);
  assert.deepEqual(terminalError.usage, {
    inputTokens: 40,
    cachedInputTokens: 8,
    outputTokens: 4,
    totalTokens: 44,
  });
  assertStagePairs(events);
  assert.equal(findFinishEvent(events, "analysis").status, "failed");
  assert.match(
    findFinishEvent(events, "analysis").error,
    /failed after 3 complete attempts/,
  );
  assert.equal(findFinishEvent(events, "analysis").metrics.totalTokens, 44);
  assert.equal(
    events.some((event) => event.stageId === "analysis.persist-artifacts"),
    false,
  );

  for (let failedAttempt = 1; failedAttempt <= 3; failedAttempt += 1) {
    const stageId = `analysis.attempt-${failedAttempt}`;
    const attemptFinish = findFinishEvent(events, stageId);

    assert.equal(attemptFinish.status, "failed");
    assert.equal(
      attemptFinish.metrics.willRetry,
      failedAttempt < 3,
    );
    assert.equal(
      findFinishEvent(
        events,
        `${stageId}.evaluation.validate-candidate`,
      ).status,
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

// runShardedMiniTrees only fires once review-stack returns more than one stack.
// Stack A deliberately exceeds MAX_FILES_PER_MINI_TREES_SHARD so this also proves
// the complete-stack flow-only call fills the layer-flow that shards cannot produce.
const shardedDiff = Array.from({ length: 17 }, (_, index) => {
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
  const stackAFiles = inventory.files.slice(0, 16);
  const stackBFiles = inventory.files.slice(16);
  const stackA = { id: "stack-a", title: "Stack A", comment: "The oversized change.", fileIds: stackAFiles.map((file) => file.id) };
  const stackB = { id: "stack-b", title: "Stack B", comment: "The independent change.", fileIds: stackBFiles.map((file) => file.id) };
  const shardedReviewStack = { schemaVersion: "pr-graph-review-stack/v1", stacks: [stackA, stackB] };
  const fullStackAFlow = {
    edges: stackA.fileIds.slice(1).map((fileId, order) => ({
      from: stackA.fileIds[0],
      to: fileId,
      order,
      comment: "Review this supporting file after the root change.",
    })),
  };
  const calls = [];

  await writeRunInputs({
    inventory,
    metadata: { number: 4, title: "Sharded mini-trees" },
    runDir: shardedRunDir,
  });

  const buildShardCandidate = (files) => ({
    schemaVersion: "pr-graph-mini-trees/v2",
    intent: "Review the sharded change.",
    summary: "Several related files and one independent file change.",
    confidence: 1,
    fileFlow: {
      edges: files.slice(1).map((file, order) => ({
        from: files[0].id,
        to: file.id,
        order,
        comment: "Review this file after the shard root.",
      })),
    },
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      reviewClass: "important",
      changeRole: "runtime",
      comment: "This file owns its constant update.",
      miniTree: {
        nodes: [{
          id: "change-constant",
          title: "Change the constant",
          reviewClass: "important",
          changeRole: "runtime",
          comment: "The constant value changes.",
          changedLineRanges: toRanges(file.changedLineIds),
        }],
        reviewEdges: [],
        relations: [],
      },
    })),
  });

  const executeCodex = async ({ outputPath, prompt, schemaPath }) => {
    if (schemaPath.includes("03-create-review-stack")) {
      calls.push("review-stack-1");
      await writeFile(outputPath, `${JSON.stringify(shardedReviewStack)}\n`, "utf8");
      return { usage: {} };
    }

    if (schemaPath.endsWith("file-flow.schema.json")) {
      calls.push("flow-a");
      assert.deepEqual(
        extractJsonTag(prompt, "files_json").map((file) => file.id),
        stackA.fileIds,
      );
      await writeFile(outputPath, `${JSON.stringify(fullStackAFlow)}\n`, "utf8");
      return { usage: {} };
    }

    assert.match(schemaPath, /02-create-mini-trees/);
    const inputFileIds = extractJsonTag(prompt, "structured_diff_json").files.map((file) => file.id);
    const inputFiles = inputFileIds.map((fileId) => (
      inventory.files.find((file) => file.id === fileId)
    ));

    if (prompt.includes(`"${stackA.title}" review stack`)) {
      calls.push(`mini-a-${inputFiles.length}`);
      await writeFile(outputPath, `${JSON.stringify(buildShardCandidate(inputFiles))}\n`, "utf8");
    } else if (prompt.includes(`"${stackB.title}" review stack`)) {
      calls.push("mini-b-1");
      await writeFile(outputPath, `${JSON.stringify(buildShardCandidate(inputFiles))}\n`, "utf8");
    } else {
      assert.fail("Mini-tree shard prompt did not name its review stack.");
    }

    return { usage: {} };
  };

  const shardedEvents = [];
  const result = await runCodexGraphAnalysis({
    executeCodex,
    model: "selected-model",
    onEvent: async (event) => {
      shardedEvents.push(event);
    },
    reasoningEffort: "xhigh",
    runDir: shardedRunDir,
  });

  assert.deepEqual(calls.sort(), ["flow-a", "mini-a-1", "mini-a-15", "mini-b-1", "review-stack-1"]);
  assert.deepEqual(
    result.analysis.files.map((file) => file.id).sort(),
    inventory.files.map((file) => file.id).sort(),
  );
  assert.deepEqual(result.analysis.fileFlows, {
    [stackA.id]: fullStackAFlow,
    [stackB.id]: { edges: [] },
  });
  assert.equal(result.analysis.fileFlow, undefined);
  validateMiniTreeAnalysis(result.analysis, { inventory, reviewStack: shardedReviewStack });
  const shardedAnalysisMetrics = findFinishEvent(shardedEvents, "analysis").metrics;
  assert.equal(shardedAnalysisMetrics.badRootCount, 0);
  assert.equal(shardedAnalysisMetrics.flowDepth, 1);
  assert.equal(shardedAnalysisMetrics.sourceOrderMatch, 1);
} finally {
  await rm(shardedRunDir, { force: true, recursive: true });
}

function assertStageTimeline(events, expected) {
  assert.deepEqual(
    events.map((event) => [
      event.type,
      event.stageId,
      event.status,
    ].filter(Boolean).join(":")),
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
        event.status === "completed"
        || event.status === "failed"
        || event.status === "canceled"
        || event.status === "skipped",
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
    (candidate) => (
      candidate.type === "stage-finish" && candidate.stageId === stageId
    ),
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
  const nodes = [
      {
        id: "change-value",
      title: "Change the value",
      reviewClass: "important",
      changeRole: "runtime",
      comment: "The value change is the core runtime behavior.",
      changedLineRanges: toRanges(rootLineIds),
    },
  ];
  const reviewEdges = [];

  if (supportingLineIds.length > 0) {
    nodes.push({
      id: "validate-value",
      title: "Validate the value",
      reviewClass: "supporting",
      changeRole: "runtime",
      comment: "Validation is required by the changed runtime value.",
      changedLineRanges: toRanges(supportingLineIds),
    });
    reviewEdges.push({
      from: "change-value",
      to: "validate-value",
      order: 0,
      comment: "Changing the value requires validating it.",
    });
  }

  return {
    schemaVersion: "pr-graph-mini-trees/v2",
    intent: "Review the example change",
    summary: "Update and validate the example value.",
    confidence: 1,
    fileFlow: { edges: [] },
    files: [
      {
        id: fileId,
        path: filePath,
        reviewClass: "important",
        changeRole: "runtime",
        comment: "This file owns the value update and its validation.",
        miniTree: {
          nodes,
          reviewEdges,
          relations: [],
        },
      },
    ],
  };
}

function toRanges(lineIds) {
  return lineIds.length === 0
    ? []
    : [{ start: lineIds[0], end: lineIds.at(-1) }];
}

// Mirrors codex-agent.js's single-stack normalization: a raw mini-trees response's
// top-level `fileFlow` becomes `fileFlows` keyed by stack id.
function withFileFlows(candidate, stackId) {
  const { fileFlow, ...rest } = candidate;
  return { ...rest, fileFlows: { [stackId]: fileFlow } };
}

async function writeRunInputs({ inventory, metadata, runDir }) {
  await Promise.all([
    writeFile(path.join(runDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8"),
    writeFile(path.join(runDir, "diff.patch"), diff, "utf8"),
    writeFile(
      path.join(runDir, "diff-inventory.json"),
      `${JSON.stringify(inventory)}\n`,
      "utf8",
    ),
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
