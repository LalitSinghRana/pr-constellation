import { isAcceptableFileTreeRoot } from "../../05-validate-candidate/validate-analysis.js";

export function computeFileTreeMetrics({ analysis, inventory }) {
  const reviewStacks = analysis?.reviewStacks || [];
  const fileById = new Map((analysis?.files || []).map((file) => [file.id, file]));
  const inventoryOrderById = new Map(
    (inventory?.files || []).map((file, index) => [file.id, index]),
  );

  let fileTreeDepth = 0;
  let stacksWithTree = 0;
  let sourceOrderMatches = 0;
  let invalidFileTreeRootCount = 0;

  for (const stack of reviewStacks) {
    const branches = stack.fileTree?.branches;
    if (!Array.isArray(branches)) {
      continue;
    }
    stacksWithTree += 1;

    const childBranchesByParentId = new Map();
    const hasIncoming = new Set();
    for (const branch of branches) {
      const children = childBranchesByParentId.get(branch.parentId) || [];
      children.push(branch);
      childBranchesByParentId.set(branch.parentId, children);
      hasIncoming.add(branch.childId);
    }
    const rootId = (stack.fileIds || []).find((fileId) => !hasIncoming.has(fileId));

    fileTreeDepth = Math.max(fileTreeDepth, measureFileTreeDepth(rootId, childBranchesByParentId));

    const treeOrderIds = fileTreeDfsOrder(rootId, childBranchesByParentId);
    const sourceOrderIds = (stack.fileIds || [])
      .slice()
      .sort(
        (left, right) => (inventoryOrderById.get(left) ?? 0) - (inventoryOrderById.get(right) ?? 0),
      );
    if (
      treeOrderIds.length === sourceOrderIds.length &&
      treeOrderIds.every((fileId, index) => fileId === sourceOrderIds[index])
    ) {
      sourceOrderMatches += 1;
    }

    if (rootId) {
      const rootFile = fileById.get(rootId);
      const stackFiles = (stack.fileIds || [])
        .map((fileId) => fileById.get(fileId))
        .filter(Boolean);
      if (rootFile && !isAcceptableFileTreeRoot(rootFile, stackFiles)) {
        invalidFileTreeRootCount += 1;
      }
    }
  }

  return {
    invalidFileTreeRootCount,
    fileTreeDepth,
    sourceOrderMatch: stacksWithTree > 0 ? sourceOrderMatches / stacksWithTree : null,
  };
}

function measureFileTreeDepth(rootId, childBranchesByParentId) {
  if (!rootId) {
    return 0;
  }

  let maxDepth = 0;
  const visit = (fileId, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    for (const branch of childBranchesByParentId.get(fileId) || []) {
      visit(branch.childId, depth + 1);
    }
  };
  visit(rootId, 0);
  return maxDepth;
}

function fileTreeDfsOrder(rootId, childBranchesByParentId) {
  if (!rootId) {
    return [];
  }

  const order = [];
  const visit = (fileId) => {
    order.push(fileId);
    const children = (childBranchesByParentId.get(fileId) || [])
      .slice()
      .sort((left, right) => left.order - right.order);
    for (const branch of children) {
      visit(branch.childId);
    }
  };
  visit(rootId);
  return order;
}
