import assert from "node:assert/strict";
import { foldMiniTree } from "../../src/review/mini-tree-model.js";

const file = {
  id: "file-1",
  miniTree: {
    nodes: [
      node("root", "important", "runtime", 8),
      node("press", "important", "runtime", 10),
      node("loading", "supporting", "runtime", 7),
      node("loading-styles", "supporting", "runtime", 5),
      node("visual", "supporting", "runtime", 6),
      node("visual-imports", "mechanical", "imports", 3),
      node("props", "mechanical", "type", 4),
    ],
    reviewEdges: [
      reviewEdge("root", "press", 0),
      reviewEdge("root", "loading", 1),
      reviewEdge("root", "visual", 2),
      reviewEdge("root", "props", 3),
      reviewEdge("loading", "loading-styles", 0),
      reviewEdge("visual", "visual-imports", 0),
    ],
    relations: [
      {
        from: "press",
        to: "props",
        relation: "uses",
        comment: "The handler consumes the component contract.",
      },
    ],
  },
};

const collapsed = foldMiniTree(file);
assert.deepEqual(
  collapsed.nodes.map((item) => item.id),
  [
    "root",
    "press",
    "ui-fold-root-supporting-runtime",
    "ui-fold-root-mechanical",
  ],
);
assert.deepEqual(
  collapsed.reviewEdges.map((edge) => `${edge.from}->${edge.to}`),
  [
    "root->press",
    "root->ui-fold-root-supporting-runtime",
    "root->ui-fold-root-mechanical",
  ],
);
assert.equal(
  collapsed.nodes.find((item) => item.id === "ui-fold-root-supporting-runtime")
    .collapsedGroup.nodeCount,
  4,
);
assert.match(
  collapsed.nodes.find((item) => item.id === "ui-fold-root-supporting-runtime")
    .comment,
  /- What:/,
);
assert.match(
  collapsed.reviewEdges.find((edge) => edge.to === "ui-fold-root-supporting-runtime")
    .comment,
  /because these lower-priority changes support/,
);
assert.doesNotMatch(
  collapsed.reviewEdges.find((edge) => edge.to === "ui-fold-root-supporting-runtime")
    .comment,
  /folded until/,
);
assert.equal(collapsed.relations.length, 1);

const supportingGroupId = "file-1:ui-fold-root-supporting-runtime";
const expandedSupporting = foldMiniTree(file, {
  expandedGroupIds: new Set([supportingGroupId]),
});
assert.ok(expandedSupporting.nodes.some((item) => item.id === "loading"));
assert.ok(expandedSupporting.nodes.some((item) => item.id === "loading-styles"));
assert.ok(expandedSupporting.nodes.some((item) => item.id === "visual"));
assert.ok(expandedSupporting.nodes.some((item) => item.id === "ui-fold-visual-mechanical"));
assert.ok(!expandedSupporting.nodes.some((item) => item.id === "visual-imports"));
assert.ok(
  expandedSupporting.reviewEdges.some((edge) => {
    return edge.from === "ui-fold-root-supporting-runtime" && edge.to === "loading";
  }),
);

const expandedAllVisibleGroups = foldMiniTree(file, {
  expandedGroupIds: new Set([
    supportingGroupId,
    "file-1:ui-fold-root-mechanical",
    "file-1:ui-fold-visual-mechanical",
  ]),
});
assert.ok(expandedAllVisibleGroups.nodes.some((item) => item.id === "props"));
assert.ok(expandedAllVisibleGroups.nodes.some((item) => item.id === "visual-imports"));

function node(id, reviewClass, changeRole, lineCount) {
  return {
    id,
    title: id,
    reviewClass,
    changeRole,
    comment: `${id} review node`,
    changedLineIds: Array.from({ length: lineCount }, (_, index) => `${id}-${index}`),
  };
}

function reviewEdge(from, to, order) {
  return {
    from,
    to,
    order,
    comment: `Review ${to} after ${from}.`,
  };
}
