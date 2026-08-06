import assert from "node:assert/strict";
import { foldFileTree } from "../../src/review/file-tree-model.js";

const file = {
  id: "file-1",
  fileTree: {
    sections: [
      section("root", "primary", "runtime", 8),
      section("press", "primary", "runtime", 10),
      section("loading", "secondary", "runtime", 7),
      section("loading-styles", "secondary", "runtime", 5),
      section("visual", "secondary", "runtime", 6),
      section("visual-imports", "skim", "imports", 3),
      section("props", "skim", "type", 4),
    ],
    branches: [
      reviewBranch("root", "press", 0),
      reviewBranch("root", "loading", 1),
      reviewBranch("root", "visual", 2),
      reviewBranch("root", "props", 3),
      reviewBranch("loading", "loading-styles", 0),
      reviewBranch("visual", "visual-imports", 0),
    ],
  },
};

const collapsed = foldFileTree(file);
assert.deepEqual(
  collapsed.sections.map((item) => item.id),
  [
    "root",
    "press",
    "ui-fold-root-secondary-runtime",
    "ui-fold-root-skim",
  ],
);
assert.deepEqual(
  collapsed.branches.map((branch) => `${branch.parentId}->${branch.childId}`),
  [
    "root->press",
    "root->ui-fold-root-secondary-runtime",
    "root->ui-fold-root-skim",
  ],
);
assert.equal(
  collapsed.sections.find((item) => item.id === "ui-fold-root-secondary-runtime")
    .reviewGroup.sectionCount,
  4,
);
assert.match(
  collapsed.sections.find((item) => item.id === "ui-fold-root-secondary-runtime")
    .explanation,
  /- What:/,
);
assert.match(
  collapsed.branches.find((branch) => branch.childId === "ui-fold-root-secondary-runtime")
    .explanation,
  /because these lower-priority changes support/,
);
assert.doesNotMatch(
  collapsed.branches.find((branch) => branch.childId === "ui-fold-root-secondary-runtime")
    .explanation,
  /folded until/,
);
const secondaryGroupId = "file-1:ui-fold-root-secondary-runtime";
const expandedSecondary = foldFileTree(file, {
  expandedGroupIds: new Set([secondaryGroupId]),
});
assert.ok(expandedSecondary.sections.some((item) => item.id === "loading"));
assert.ok(expandedSecondary.sections.some((item) => item.id === "loading-styles"));
assert.ok(expandedSecondary.sections.some((item) => item.id === "visual"));
assert.ok(expandedSecondary.sections.some((item) => item.id === "ui-fold-visual-skim"));
assert.ok(!expandedSecondary.sections.some((item) => item.id === "visual-imports"));
assert.ok(
  expandedSecondary.branches.some((branch) => {
    return branch.parentId === "ui-fold-root-secondary-runtime" && branch.childId === "loading";
  }),
);

const expandedAllVisibleGroups = foldFileTree(file, {
  expandedGroupIds: new Set([
    secondaryGroupId,
    "file-1:ui-fold-root-skim",
    "file-1:ui-fold-visual-skim",
  ]),
});
assert.ok(expandedAllVisibleGroups.sections.some((item) => item.id === "props"));
assert.ok(expandedAllVisibleGroups.sections.some((item) => item.id === "visual-imports"));

const orderedFile = {
  id: "ordered-file",
  fileTree: {
    sections: [
      section("root", "primary", "runtime", 1),
      section("next-sibling", "primary", "runtime", 1),
      section("grouped-change", "skim", "imports", 1),
      section("descendant", "primary", "runtime", 1),
      section("first-child", "secondary", "runtime", 1),
    ],
    branches: [
      reviewBranch("root", "next-sibling", 2),
      reviewBranch("root", "grouped-change", 1),
      reviewBranch("root", "first-child", 0),
      reviewBranch("first-child", "descendant", 0),
    ],
  },
};
const orderedCollapsed = foldFileTree(orderedFile);
const orderedGroupId = "ordered-file:ui-fold-root-skim";
const orderedCollapsedIds = orderedCollapsed.sections.map((item) => item.id);

assert.deepEqual(
  orderedCollapsedIds,
  ["root", "first-child", "descendant", "ui-fold-root-skim", "next-sibling"],
  "authored branch order should control visible DFS order, regardless of section labels or declaration order",
);
assert.deepEqual(
  [
    "file:ordered-file",
    ...orderedCollapsedIds,
    "file:next-file",
    "next-file-root",
  ],
  [
    "file:ordered-file",
    "root",
    "first-child",
    "descendant",
    "ui-fold-root-skim",
    "next-sibling",
    "file:next-file",
    "next-file-root",
  ],
);

const orderedExpanded = foldFileTree(orderedFile, {
  expandedGroupIds: new Set([orderedGroupId]),
});
assert.deepEqual(
  orderedExpanded.sections.map((item) => item.id),
  [
    "root",
    "first-child",
    "descendant",
    "ui-fold-root-skim",
    "grouped-change",
    "next-sibling",
  ],
  "expansion should retain the group step and insert its child immediately after it",
);

function section(id, reviewPriority, changeKind, lineCount) {
  return {
    id,
    title: id,
    reviewPriority,
    changeKind,
    explanation: `${id} review section`,
    changedLineIds: Array.from({ length: lineCount }, (_, index) => `${id}-${index}`),
  };
}

function reviewBranch(parentId, childId, order) {
  return {
    parentId,
    childId,
    order,
    explanation: `Review ${childId} after ${parentId}.`,
  };
}
