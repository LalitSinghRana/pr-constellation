import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewTree, sectionMaxHeightFromCanvas } from "../src/review/review-tree/layout.js";

globalThis.window = {
  innerWidth: 1280,
};

test("many-line review sections clamp to sectionMaxHeight", () => {
  const lines = Array.from({ length: 80 }, (_, index) => ({
    id: `file-1:${index + 1}`,
    content: `const line${index + 1} = ${index + 1};`,
    type: "add",
  }));
  const analysis = {
    files: [
      {
        id: "file-1",
        path: "src/large.ts",
        reviewPriority: "primary",
        changeKind: "runtime",
        changedLineIds: lines.map((line) => line.id),
        sourceCodeChunks: [{ lines }],
        sectionTree: {
          sections: [
            {
              id: "change",
              title: "Change",
              reviewPriority: "primary",
              changeKind: "runtime",
              changedLineIds: lines.map((line) => line.id),
              codeChunks: [{ lines }],
            },
          ],
          branches: [],
          groupIds: [],
        },
      },
    ],
    reviewStacks: [],
  };

  const sectionMaxHeight = 400;
  const tree = buildReviewTree(analysis, { sectionMaxHeight });
  const sectionNode = tree.nodes.find((node) => node.type === "reviewSection");

  assert.ok(sectionNode, "expected a review section node");
  assert.equal(sectionNode.style.height, sectionMaxHeight);
  assert.ok(sectionNode.style.height < 80 * 18 + 42);
});

test("sectionMaxHeightFromCanvas matches the step camera viewport height", () => {
  assert.equal(sectionMaxHeightFromCanvas(0), Number.POSITIVE_INFINITY);
  assert.equal(sectionMaxHeightFromCanvas(900), Math.floor((900 - 176 - 32) / 1.25));
});
