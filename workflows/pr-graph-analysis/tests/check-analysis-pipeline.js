import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDiffInventory } from "../03-build-diff-inventory/diff-inventory.js";
import { runCodexGraphAnalysis } from "../07-run-retry-loop/codex-agent.js";

const miniTreeSchema = JSON.parse(
  await readFile(
    new URL(
      "../04-generate-candidate-analysis/02-create-mini-trees/schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

assert.match(
  miniTreeSchema.$defs.miniNode.properties.comment.description,
  /What this cohesive code section changes or proves and why/,
);
assert.match(
  miniTreeSchema.$defs.reviewEdge.properties.comment.description,
  /why the target belongs next/,
);
assert.match(
  miniTreeSchema.$defs.reviewEdge.properties.comment.description,
  /longer than 280 characters require at least two bullet lines/,
);

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
  const candidates = [incompleteCandidate, validCandidate];
  const calls = [];
  const judgePrompts = [];
  const miniPrompts = [];
  let analysisAttempt = 0;
  let judgeAttempt = 0;

  await writeRunInputs({
    inventory,
    metadata: { number: 1, title: "Pipeline order" },
    runDir,
  });

  const executeCodex = async ({ outputPath, prompt, schemaPath }) => {
    if (schemaPath.includes("06-judge-candidate")) {
      judgeAttempt += 1;
      calls.push(`judge-${judgeAttempt}`);
      judgePrompts.push(prompt);
      await writeFile(
        outputPath,
        `${JSON.stringify({
          schemaVersion: "pr-graph-judge/v1",
          verdict: judgeAttempt === 1 ? "fail" : "pass",
          confidence: 1,
          summary: judgeAttempt === 1 ? "Retry the incomplete candidate." : "Candidate is ready.",
          findings: judgeAttempt === 1
            ? [{
                severity: "blocker",
                type: "validation",
                targetId: "validate-value",
                comment: "The mini-tree omits one changed line.",
              }]
            : [],
        })}\n`,
        "utf8",
      );
      return;
    }

    assert.match(schemaPath, /02-create-mini-trees/);
    analysisAttempt += 1;
    calls.push(`mini-${analysisAttempt}`);
    miniPrompts.push(prompt);
    await writeFile(
      outputPath,
      `${JSON.stringify(candidates[analysisAttempt - 1])}\n`,
      "utf8",
    );
  };

  const result = await runCodexGraphAnalysis({ executeCodex, runDir });

  assert.deepEqual(calls, ["mini-1", "judge-1", "mini-2", "judge-2"]);
  assert.deepEqual(
    extractJsonTag(judgePrompts[0], "analysis_candidate_json"),
    incompleteCandidate,
  );
  assert.match(judgePrompts[0], /<validation_result>\s*FAIL/);
  assert.match(miniPrompts[1], /Step 05 validate candidate failed/);
  assert.match(miniPrompts[1], /Step 06 judge candidate failed/);
  assert.match(miniPrompts[0], /<diff_line_map_json>/);
  assert.match(miniPrompts[0], /## Explanation Comments: What And Why/);
  assert.match(
    miniPrompts[0],
    /code attached to a mini-node already tells the reviewer \*\*how\*\*/,
  );
  assert.match(miniPrompts[0], /use Markdown bullet points inside the/);
  assert.match(
    miniPrompts[0],
    /every comment longer than 280 characters must contain at least two/,
  );
  assert.match(miniPrompts[0], /compress a naturally multi-point explanation below 280/);
  assert.match(miniPrompts[0], /## Cohesive Review Units/);
  assert.match(
    miniPrompts[0],
    /Partition each file into cohesive review units before assigning/,
  );
  assert.match(miniPrompts[0], /Do not emit numeric node depths/);
  assert.match(judgePrompts[0], /## Mandatory Section-Cohesion Audit/);
  assert.match(judgePrompts[0], /## Mandatory Comment Audit/);
  assert.match(
    judgePrompts[0],
    /attached code answers \*\*how\*\* the implementation works/,
  );
  assert.match(
    judgePrompts[0],
    /comment longer than 280 characters without at/,
  );
  assert.match(judgePrompts[0], /least two Markdown bullet lines/);
  assert.match(judgePrompts[0], /artificial threshold avoidance/);
  assert.match(
    judgePrompts[0],
    /contiguous JSX\/render phase split into separate loading/,
  );
  assert.deepEqual(result.analysis, validCandidate);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "mini-trees.raw.json"), "utf8")),
    incompleteCandidate,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "mini-trees.raw.attempt-2.json"), "utf8")),
    validCandidate,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "analysis.raw.attempt-2.json"), "utf8")),
    validCandidate,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runDir, "analysis.json"), "utf8")),
    validCandidate,
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
  let attempt = 0;

  await writeRunInputs({
    inventory,
    metadata: { number: 2, title: "No fallback" },
    runDir: failedRunDir,
  });

  const executeCodex = async ({ outputPath, schemaPath }) => {
    if (schemaPath.includes("02-create-mini-trees")) {
      attempt += 1;
      calls.push(`mini-${attempt}`);
      await writeFile(outputPath, `${JSON.stringify(incompleteCandidate)}\n`, "utf8");
      return;
    }

    calls.push(`judge-${attempt}`);
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
  };

  await assert.rejects(
    runCodexGraphAnalysis({ executeCodex, runDir: failedRunDir }),
    /PR mini-tree analysis failed after 5 complete attempts/,
  );
  assert.deepEqual(calls, [
    "mini-1",
    "judge-1",
    "mini-2",
    "judge-2",
    "mini-3",
    "judge-3",
    "mini-4",
    "judge-4",
    "mini-5",
    "judge-5",
  ]);
  await assert.rejects(
    readFile(path.join(failedRunDir, "analysis.json"), "utf8"),
    (error) => error?.code === "ENOENT",
  );
} finally {
  await rm(failedRunDir, { force: true, recursive: true });
}

function buildCandidate({ coveredLineIds, fileId, filePath }) {
  const rootLineIds = coveredLineIds.slice(0, 2);
  const supportingLineIds = coveredLineIds.slice(2);
  const nodes = [
    {
      id: "change-value",
      title: "Change the value",
      reviewClass: "core",
      changeRole: "runtime",
      comment: "The value change is the core runtime behavior.",
      changedLineIds: rootLineIds,
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
      changedLineIds: supportingLineIds,
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
    files: [
      {
        id: fileId,
        path: filePath,
        reviewClass: "important",
        changeRole: "runtime",
        comment: "This file owns the value update and its validation.",
        codeRefs: {
          fileIds: [fileId],
          changedLineIds: coveredLineIds,
        },
        miniTree: {
          nodes,
          reviewEdges,
          relations: [],
        },
      },
    ],
  };
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
