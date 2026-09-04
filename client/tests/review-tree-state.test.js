import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFileViewModeOverrides,
  resolveActiveStackId,
  resolveFileViewMode,
} from "../src/review/review-tree/state.js";

const stacks = [
  { id: "runtime", title: "Runtime" },
  { id: "tests", title: "Tests" },
];

test("resolveActiveStackId uses the first stack before a selection exists", () => {
  assert.equal(resolveActiveStackId(stacks, null), "runtime");
});

test("resolveActiveStackId keeps a selected stack that still exists", () => {
  assert.equal(resolveActiveStackId(stacks, "tests"), "tests");
});

test("resolveActiveStackId falls back when the selected stack is gone", () => {
  assert.equal(resolveActiveStackId(stacks, "missing"), "runtime");
  assert.equal(resolveActiveStackId([], "runtime"), null);
});

test("resolveFileViewMode uses the settings default when no override exists", () => {
  assert.equal(resolveFileViewMode("file-1", new Map(), "tree"), "tree");
  assert.equal(resolveFileViewMode("file-1", new Map(), "source"), "source");
});

test("resolveFileViewMode prefers an explicit per-file override", () => {
  const overrides = new Map([
    ["file-1", "source"],
    ["file-2", "tree"],
  ]);
  assert.equal(resolveFileViewMode("file-1", overrides, "tree"), "source");
  assert.equal(resolveFileViewMode("file-2", overrides, "source"), "tree");
});

test("parseFileViewModeOverrides migrates the legacy source-id array", () => {
  const overrides = parseFileViewModeOverrides(["file-1", "file-2"]);
  assert.equal(overrides.get("file-1"), "source");
  assert.equal(overrides.get("file-2"), "source");
  assert.equal(overrides.size, 2);
});

test("parseFileViewModeOverrides keeps an explicit override map", () => {
  const overrides = parseFileViewModeOverrides({
    "file-1": "tree",
    "file-2": "source",
    "file-3": "nope",
  });
  assert.equal(overrides.get("file-1"), "tree");
  assert.equal(overrides.get("file-2"), "source");
  assert.equal(overrides.has("file-3"), false);
});
