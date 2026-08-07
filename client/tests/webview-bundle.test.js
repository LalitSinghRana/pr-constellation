import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderDiffHtml } from "../src/review/render.js";

const html = await renderDiffHtml({
  analysis: {
    schemaVersion: "pr-review-analysis/v1",
    intent: "Check review tree rendering",
    summary: "A minimal Section Tree verifies the embedded review bundle.",
    confidence: 1,
    reviewStacks: [
      {
        id: "stack-1",
        title: "Runtime change",
        explanation: "Review the runtime change as one stack.",
        fileIds: ["file-1"],
        fileTree: { branches: [] },
      },
    ],
    files: [
      {
        id: "file-1",
        path: "src/example.js",
        reviewPriority: "primary",
        changeKind: "runtime",
        explanation: "This file owns the runtime behavior under review.",
        changedLineIds: ["file-1:hunk-1:line-1", "file-1:hunk-1:line-2"],
        sectionTree: {
          sections: [
            {
              id: "replace-old-value",
              title: "Replace old value",
              reviewPriority: "primary",
              changeKind: "runtime",
              explanation: "Callers must observe the updated behavior.",
              changedLineIds: ["file-1:hunk-1:line-1"],
            },
            {
              id: "set-new-value",
              title: "Set new value",
              reviewPriority: "secondary",
              changeKind: "runtime",
              explanation: "The replacement value supports the reviewed behavior.",
              changedLineIds: ["file-1:hunk-1:line-2"],
            },
          ],
          branches: [
            {
              parentId: "replace-old-value",
              childId: "set-new-value",
              order: 0,
              explanation: "The assignment supplies the value callers now observe.",
            },
          ],
        },
      },
    ],
  },
  diff: `diff --git a/src/example.js b/src/example.js
index 0000000..1111111 100644
--- a/src/example.js
+++ b/src/example.js
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`,
  pr: {
    additions: 1,
    author: { login: "check" },
    baseRefName: "main",
    changedFiles: 1,
    deletions: 1,
    headRefName: "branch",
    number: 1,
    state: "OPEN",
    title: "Check",
    url: "https://github.com/example/repo/pull/1",
  },
});

for (const marker of [
  "pr-review-root",
  "review-tree",
  "review-section-gap-divider",
  "file-node-label",
  "section-tree-edge",
  "explanation-hover-card",
  "review-group",
  "--section-tree-color",
  "--file-tree-color",
  "PrReviewTree",
]) {
  assert.ok(html.includes(marker), `Missing review bundle marker: ${marker}`);
}

const treeData = extractJsonScript(html, "pr-analysis-data");
assert.equal(treeData.schemaVersion, "pr-review-analysis/v1");
assert.equal(treeData.reviewStacks[0].fileTree.branches.length, 0);
assert.equal(treeData.files[0].sectionTree.branches[0].order, 0);
assert.match(treeData.files[0].sectionTree.branches[0].explanation, /supplies/);
assert.equal(treeData.files[0].sectionTree.sections[0].codeChunks.length, 1);
assert.equal(treeData.files[0].sourceCodeChunks.length, 1);
assert.deepEqual(
  treeData.files[0].sourceCodeChunks[0].lines.map((line) => line.content),
  ["const value = 1;", "const value = 2;"],
);
assert.ok(
  treeData.files[0].sourceCodeChunks[0].lines
    .flatMap((line) => line.syntaxTokens)
    .some((token) => token.style?.includes("--shiki-light")),
  "the server-side highlighter should provide styled syntax tokens",
);
assert.ok(!("relations" in treeData.files[0].sectionTree));

const [treeAppSource, treeLayoutSource, webStyles] = await Promise.all([
  readFile(new URL("../src/review/review-tree-app.jsx", import.meta.url), "utf8"),
  readFile(new URL("../src/review/review-tree/layout.js", import.meta.url), "utf8"),
  readFile(new URL("../src/review/styles.css", import.meta.url), "utf8"),
]);
const reviewTreeSource = `${treeAppSource}\n${treeLayoutSource}`;
assert.match(reviewTreeSource, /nodesDraggable=\{false\}/);
assert.match(reviewTreeSource, /reviewBranch: React\.memo\(ReviewBranch\)/);
assert.match(reviewTreeSource, /filter\(\(\{ type \}\) => type === "reviewSection"\)/);
assert.match(reviewTreeSource, /foldSectionTree\(file, \{ expandedGroupIds \}\)/);
assert.match(reviewTreeSource, /value="source"/);
assert.match(reviewTreeSource, /ariaLabel="Review tree map"/);
assert.match(reviewTreeSource, /pointerEvents: "auto"/);
assert.match(treeAppSource, /text-base leading-relaxed/);
assert.match(treeAppSource, /bg-diff-add\/15/);
assert.match(treeAppSource, /text-pr-open/);
assert.doesNotMatch(treeAppSource, /What \/ Why/);
assert.doesNotMatch(treeAppSource, /formatExplanationForHover/);
assert.doesNotMatch(treeAppSource, /state-badge/);
assert.doesNotMatch(treeAppSource, /text-\[15px\]/);
assert.match(webStyles, /\.review-branch-hit-path/);
assert.match(webStyles, /\.review-tree-map/);
assert.doesNotMatch(webStyles, /\.change-pill\.is-add/);
assert.doesNotMatch(webStyles, /\.review-mark\.is-open/);

function extractJsonScript(documentHtml, id) {
  const match = documentHtml.match(
    new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)<\\/script>`),
  );
  assert.ok(match, `Missing JSON script: ${id}`);
  return JSON.parse(match[1]);
}
