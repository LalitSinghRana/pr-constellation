import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMENT_PANEL_WIDTH,
  findCommentAnchorRow,
  latestCommentKeyOnSection,
  measureLineAnchor,
} from "../src/review/comment-layout.js";

test("measureLineAnchor centers the panel on the line inside the host node", () => {
  const host = {
    getBoundingClientRect: () => ({ height: 400, top: 100 }),
    offsetHeight: 400,
  };
  const row = {
    getBoundingClientRect: () => ({ height: 20, top: 220 }),
  };
  const first = measureLineAnchor(row, host);
  assert.equal(first.top, 130);
  const second = measureLineAnchor(row, host, first);
  assert.equal(second, first);
});

test("findCommentAnchorRow prefers the matching line gutter over another marker", () => {
  const matchingRow = { id: "row-79" };
  const matchingGutter = {
    closest: (selector) => (selector === "[data-review-diff-line]" ? matchingRow : null),
    dataset: { reviewLine: "79", reviewSide: "RIGHT" },
  };
  const otherGutter = {
    closest: () => ({ id: "row-other" }),
    dataset: { reviewLine: "10", reviewSide: "RIGHT" },
    querySelector: () => ({ closest: () => ({ id: "row-other" }) }),
  };
  const container = {
    querySelector: () => otherGutter,
    querySelectorAll: () => [otherGutter, matchingGutter],
  };
  assert.equal(findCommentAnchorRow(container, { line: 79, side: "RIGHT" }), matchingRow);
});

test("latestCommentKeyOnSection opens the lowest comment that lives on the section", () => {
  const reviewSection = {
    codeChunks: [
      {
        file: "src/header.ts",
        lines: [{ newLine: 83 }, { newLine: 90 }, { newLine: 96 }],
      },
    ],
  };
  const commentIndex = new Map([
    ["src/header.ts:RIGHT:12", { path: "src/header.ts", line: 12, side: "RIGHT" }],
    ["src/header.ts:RIGHT:83", { path: "src/header.ts", line: 83, side: "RIGHT" }],
    ["src/header.ts:RIGHT:90", { path: "src/header.ts", line: 90, side: "RIGHT" }],
    ["other.ts:RIGHT:200", { path: "other.ts", line: 200, side: "RIGHT" }],
  ]);
  assert.equal(
    latestCommentKeyOnSection(reviewSection, "src/header.ts", commentIndex),
    "src/header.ts:RIGHT:90",
  );
});

test("latestCommentKeyOnSection skips dismissed comments and other files", () => {
  const reviewSection = {
    codeChunks: [{ file: "src/header.ts", lines: [{ newLine: 90 }] }],
  };
  const commentIndex = new Map([
    ["src/header.ts:RIGHT:90", { path: "src/header.ts", line: 90, side: "RIGHT" }],
    ["other.ts:RIGHT:4", { path: "other.ts", line: 4, side: "RIGHT" }],
  ]);
  assert.equal(
    latestCommentKeyOnSection(
      reviewSection,
      "src/header.ts",
      commentIndex,
      new Set(["src/header.ts:RIGHT:90"]),
    ),
    null,
  );
  assert.equal(COMMENT_PANEL_WIDTH, 520);
});
