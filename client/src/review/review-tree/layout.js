import { MarkerType } from "@xyflow/react";
import { foldSectionTree, normalizeSectionTree } from "../section-tree-model.js";

const FILE_NODE_GAP_X = 160;
const FILE_NODE_PADDING = 32;
const FILE_NODE_PADDING_TOP = 72;
const FILE_NODE_MIN_HEIGHT = 180;
const FILE_NODE_STACK_GAP_Y = 56;
const REVIEW_SECTION_CODE_CHARACTER_COLUMNS = 120;
const REVIEW_SECTION_CODE_CHARACTER_WIDTH = 7;
const REVIEW_SECTION_GUTTER_WIDTH = 102;
const REVIEW_SECTION_HORIZONTAL_PADDING = 18;
const REVIEW_SECTION_WIDTH =
  REVIEW_SECTION_CODE_CHARACTER_COLUMNS * REVIEW_SECTION_CODE_CHARACTER_WIDTH +
  REVIEW_SECTION_GUTTER_WIDTH +
  REVIEW_SECTION_HORIZONTAL_PADDING;
const REVIEW_SECTION_HEADER_HEIGHT = 42;
const REVIEW_GROUP_HEIGHT = 118;
const REVIEW_GROUP_WIDTH = 520;
const SECTION_TREE_LAYER_GAP_Y = 110;
const SECTION_TREE_SIBLING_GAP_X = 72;
const MIN_TREE_ZOOM = 0.18;
const FILE_TREE_LAYER_GAP_Y = FILE_NODE_STACK_GAP_Y * 3;
const FILE_TREE_SIBLING_GAP_X = FILE_NODE_GAP_X;
const VIEWPORT_PADDING_Y = 176;
const FALLBACK_TREE_VIEWPORT = { x: 72, y: 52, zoom: 0.86 };
const FILE_TREE_SOURCE_HANDLE = "file-tree-source";
const FILE_TREE_TARGET_HANDLE = "file-tree-target";
const FILE_REVIEW_PRIORITY = new Map([
  ["primary", 0],
  ["secondary", 1],
  ["skim", 2],
]);
const FILE_CHANGE_KIND_PRIORITY = new Map([
  ["runtime", 0],
  ["test", 1],
  ["storybook", 2],
  ["type", 3],
  ["config", 4],
  ["dependency", 5],
  ["docs", 6],
  ["snapshot", 7],
  ["generated", 8],
  ["formatting", 9],
  ["imports", 10],
]);

export function buildReviewTree(
  analysis,
  {
    activeStackId = null,
    expandedGroupIds = new Set(),
    sourceOrderViewIds = new Set(),
    measuredHeights = null,
  } = {},
) {
  const nodes = [];
  const edges = [];
  const fileNodes = [];
  const activeStack = activeStackId
    ? (analysis?.reviewStacks || []).find((stack) => stack.id === activeStackId)
    : null;
  const fileTreeBranches = activeStack?.fileTree?.branches || [];
  const fileSpecs = buildFileNodeSpecs(analysis, {
    activeStackId,
    expandedGroupIds,
    sourceOrderViewIds,
    measuredHeights,
  });

  for (const spec of fileSpecs) {
    const { file, reviewSections, sectionTree, nodeHeight, nodeId, nodeWidth, viewMode, x, y } =
      spec;
    if (reviewSections.length === 0) {
      continue;
    }

    const layout = spec.layout;

    nodes.push({
      id: nodeId,
      data: { file, viewMode },
      draggable: false,
      initialHeight: nodeHeight,
      initialWidth: nodeWidth,
      position: { x, y },
      selectable: false,
      style: { height: nodeHeight, pointerEvents: "none", width: nodeWidth },
      zIndex: 2,
      type: "fileNode",
    });
    fileNodes.push({
      branchCount: sectionTree.branches.length,
      height: nodeHeight,
      reviewSectionCount: reviewSections.length,
      changeKind: file.changeKind,
      reviewPriority: file.reviewPriority,
      width: nodeWidth,
      x,
      y,
    });

    for (const item of layout.sections) {
      nodes.push({
        id: reviewSectionId(file, item.section.id),
        data: {
          file,
          reviewSection: item.section,
        },
        draggable: false,
        extent: "parent",
        initialHeight: item.height,
        initialWidth: reviewSectionWidth(item.section),
        parentId: nodeId,
        position: {
          x: FILE_NODE_PADDING + item.x,
          y: FILE_NODE_PADDING_TOP + item.y,
        },
        selectable: false,
        style: { pointerEvents: "auto", width: reviewSectionWidth(item.section) },
        type: item.section.reviewGroup ? "reviewGroup" : "reviewSection",
        zIndex: 4,
      });
    }

    const reviewSectionById = new Map(
      reviewSections.map((reviewSection) => [reviewSection.id, reviewSection]),
    );
    const validReviewSectionIds = new Set(reviewSectionById.keys());
    for (const branch of sectionTree.branches) {
      if (
        !validReviewSectionIds.has(branch.parentId) ||
        !validReviewSectionIds.has(branch.childId)
      ) {
        continue;
      }

      edges.push({
        id: `${file.id}:${branch.parentId}->${branch.childId}`,
        className: "section-tree-edge",
        data: {
          explanation: branch.explanation || "",
          sourceTitle: reviewSectionById.get(branch.parentId)?.title || branch.parentId,
          targetTitle: reviewSectionById.get(branch.childId)?.title || branch.childId,
        },
        markerEnd: {
          color: "var(--section-tree-color)",
          height: 12,
          type: MarkerType.ArrowClosed,
          width: 12,
        },
        source: reviewSectionId(file, branch.parentId),
        style: {
          stroke: "var(--section-tree-color)",
          strokeLinecap: "round",
          strokeOpacity: 0.8,
          strokeWidth: 2.5,
        },
        target: reviewSectionId(file, branch.childId),
        type: "reviewBranch",
        zIndex: 4,
      });
    }
  }

  const fileSpecById = new Map(fileSpecs.map((spec) => [spec.file.id, spec]));
  for (const branch of fileTreeBranches) {
    const sourceSpec = fileSpecById.get(branch.parentId);
    const targetSpec = fileSpecById.get(branch.childId);
    if (!sourceSpec || !targetSpec) {
      continue;
    }

    edges.push({
      id: `file-tree:${branch.parentId}->${branch.childId}`,
      className: "file-tree-edge",
      data: {
        explanation: branch.explanation || "",
        sourceTitle: sourceSpec.file.path || branch.parentId,
        targetTitle: targetSpec.file.path || branch.childId,
      },
      markerEnd: {
        color: "var(--file-tree-color)",
        height: 16,
        type: MarkerType.ArrowClosed,
        width: 16,
      },
      source: sourceSpec.nodeId,
      sourceHandle: FILE_TREE_SOURCE_HANDLE,
      style: {
        stroke: "var(--file-tree-color)",
        strokeLinecap: "round",
        strokeOpacity: 0.75,
        strokeWidth: 5,
      },
      target: targetSpec.nodeId,
      targetHandle: FILE_TREE_TARGET_HANDLE,
      type: "reviewBranch",
      zIndex: 3,
    });
  }

  return {
    defaultViewport: defaultViewportForFileNodes(fileNodes),
    edges,
    groupIds: fileSpecs.flatMap((spec) => spec.sectionTree.groupIds || []),
    nodes,
  };
}

function buildFileNodeSpecs(
  analysis,
  {
    activeStackId = null,
    expandedGroupIds = new Set(),
    sourceOrderViewIds = new Set(),
    measuredHeights = null,
  } = {},
) {
  const activeStack = activeStackId
    ? (analysis?.reviewStacks || []).find((stack) => stack.id === activeStackId)
    : null;
  const activeFileIds = activeStack ? new Set(activeStack.fileIds || []) : null;
  const fileLayouts = (analysis?.files || [])
    .filter((file) => sectionTreeSections(file).length > 0)
    .filter((file) => !activeFileIds || activeFileIds.has(file.id))
    .map((file) =>
      buildFileLayout(file, {
        expandedGroupIds,
        getReviewSectionHeight: measuredHeights
          ? (node) =>
              measuredHeights.get(reviewSectionId(file, node.id)) ?? reviewSectionHeight(node)
          : reviewSectionHeight,
        viewMode: sourceOrderViewIds.has(file.id) ? "source" : "tree",
      }),
    );

  return layoutFileNodesByFileTree(fileLayouts, activeStack?.fileTree?.branches || []);
}

function layoutFileNodesByFileTree(fileLayouts, branches) {
  const items = fileLayouts.map((fileLayout, order) => ({
    fileLayout,
    height: fileLayout.nodeHeight,
    order,
    width: fileLayout.nodeWidth,
  }));
  const layout = layoutTreeTopToBottom({
    branches,
    getId: (item) => item.fileLayout.file.id,
    items,
    layerGap: FILE_TREE_LAYER_GAP_Y,
    siblingGap: FILE_TREE_SIBLING_GAP_X,
  });

  return layout.placements.map(({ item, x, y }) => ({ ...item.fileLayout, x, y }));
}

function buildFileLayout(
  file,
  {
    expandedGroupIds = new Set(),
    getReviewSectionHeight = reviewSectionHeight,
    viewMode = "tree",
  } = {},
) {
  const sectionTree =
    viewMode === "source"
      ? buildSourceOrderSectionTree(file)
      : foldSectionTree(file, { expandedGroupIds });
  const reviewSections = sectionTree.sections;
  const layout = layoutReviewSections(reviewSections, sectionTree.branches, getReviewSectionHeight);

  return {
    file,
    layout,
    reviewSections,
    sectionTree,
    nodeHeight: Math.max(
      FILE_NODE_MIN_HEIGHT,
      FILE_NODE_PADDING_TOP + layout.height + FILE_NODE_PADDING,
    ),
    nodeId: fileNodeId(file),
    nodeWidth: FILE_NODE_PADDING * 2 + layout.width,
    viewMode,
  };
}

function buildSourceOrderSectionTree(file) {
  return {
    branches: [],
    groupIds: [],
    sections: [
      {
        id: "source-order-view",
        title: "Source-order diff",
        reviewPriority: file.reviewPriority,
        changeKind: file.changeKind,
        explanation:
          "Every changed hunk stays together in source order for top-to-bottom file context, instead of the Section Tree grouping.",
        changedLineIds: file.changedLineIds || [],
        codeChunks: file.sourceCodeChunks || [],
        sourceOrderView: true,
      },
    ],
  };
}

function layoutTreeTopToBottom({ branches, getId, items, layerGap, siblingGap }) {
  if (items.length === 0) {
    return { height: 0, placements: [], width: 0 };
  }

  const itemById = new Map(items.map((item) => [getId(item), item]));
  const childrenById = new Map(items.map((item) => [getId(item), []]));
  const incomingIds = new Set();
  const reviewOrderById = new Map();

  for (const branch of branches) {
    if (
      branch.parentId === branch.childId ||
      !itemById.has(branch.parentId) ||
      !itemById.has(branch.childId) ||
      incomingIds.has(branch.childId)
    ) {
      continue;
    }

    childrenById.get(branch.parentId).push(branch.childId);
    incomingIds.add(branch.childId);
    if (Number.isInteger(branch.order)) {
      reviewOrderById.set(branch.childId, branch.order);
    }
  }

  for (const children of childrenById.values()) {
    children.sort((leftId, rightId) => {
      return (
        (reviewOrderById.get(leftId) ?? itemById.get(leftId).order) -
        (reviewOrderById.get(rightId) ?? itemById.get(rightId).order)
      );
    });
  }

  const roots = items
    .filter((item) => !incomingIds.has(getId(item)))
    .sort((left, right) => left.order - right.order);
  const orderedRoots =
    roots.length > 0 ? roots : items.slice().sort((left, right) => left.order - right.order);
  const depthById = new Map();
  const measuredById = new Map();

  function assignDepth(itemId, depth, ancestry = new Set()) {
    if (ancestry.has(itemId)) {
      return;
    }

    const knownDepth = depthById.get(itemId);
    if (knownDepth !== undefined && knownDepth <= depth) {
      return;
    }

    depthById.set(itemId, depth);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(itemId);

    for (const childId of childrenById.get(itemId) || []) {
      assignDepth(childId, depth + 1, nextAncestry);
    }
  }

  for (const root of orderedRoots) {
    assignDepth(getId(root), 0);
  }

  for (const item of items) {
    if (!depthById.has(getId(item))) {
      orderedRoots.push(item);
      assignDepth(getId(item), 0);
    }
  }

  function measure(itemId, ancestry = new Set()) {
    if (measuredById.has(itemId)) {
      return measuredById.get(itemId);
    }

    const item = itemById.get(itemId);
    if (!item || ancestry.has(itemId)) {
      return { childrenWidth: 0, subtreeWidth: item?.width || 0 };
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(itemId);
    const childMeasurements = (childrenById.get(itemId) || []).map((childId) => ({
      id: childId,
      measurement: measure(childId, nextAncestry),
    }));
    const childrenWidth = childMeasurements.reduce((total, child, index) => {
      return total + child.measurement.subtreeWidth + (index > 0 ? siblingGap : 0);
    }, 0);
    const measurement = {
      childMeasurements,
      childrenWidth,
      subtreeWidth: Math.max(item.width, childrenWidth),
    };

    measuredById.set(itemId, measurement);
    return measurement;
  }

  const maxHeightByDepth = new Map();
  for (const item of items) {
    const depth = depthById.get(getId(item)) || 0;
    maxHeightByDepth.set(depth, Math.max(maxHeightByDepth.get(depth) || 0, item.height));
  }

  const rowYByDepth = new Map();
  let cursorY = 0;
  for (const depth of [...maxHeightByDepth.keys()].sort((left, right) => left - right)) {
    rowYByDepth.set(depth, cursorY);
    cursorY += (maxHeightByDepth.get(depth) || 0) + layerGap;
  }

  const placements = [];
  const placedIds = new Set();

  function place(itemId, left) {
    if (placedIds.has(itemId)) {
      return;
    }

    const item = itemById.get(itemId);
    const measurement = measure(itemId);
    const depth = depthById.get(itemId) || 0;
    placedIds.add(itemId);
    placements.push({
      item,
      x: left + (measurement.subtreeWidth - item.width) / 2,
      y: rowYByDepth.get(depth) || 0,
    });

    let childLeft = left + (measurement.subtreeWidth - measurement.childrenWidth) / 2;
    for (const child of measurement.childMeasurements || []) {
      place(child.id, childLeft);
      childLeft += child.measurement.subtreeWidth + siblingGap;
    }
  }

  let cursorX = 0;
  for (const root of orderedRoots) {
    const rootId = getId(root);
    if (placedIds.has(rootId)) {
      continue;
    }
    const measurement = measure(rootId);
    place(rootId, cursorX);
    cursorX += measurement.subtreeWidth + siblingGap;
  }

  const width = Math.max(0, cursorX - siblingGap);
  const height = placements.reduce((maximum, placement) => {
    return Math.max(maximum, placement.y + placement.item.height);
  }, 0);

  return { height, placements, width };
}

function defaultViewportForFileNodes(fileNodes) {
  const primaryFileNode = fileNodes.reduce((best, fileNode) => {
    if (!best) {
      return fileNode;
    }
    const reviewPriorityDifference =
      fileReviewPriority(fileNode.reviewPriority) - fileReviewPriority(best.reviewPriority);
    if (reviewPriorityDifference !== 0) {
      return reviewPriorityDifference < 0 ? fileNode : best;
    }
    const changeKindDifference =
      fileChangeKindPriority(fileNode.changeKind) - fileChangeKindPriority(best.changeKind);
    if (changeKindDifference !== 0) {
      return changeKindDifference < 0 ? fileNode : best;
    }
    if (fileNode.branchCount !== best.branchCount) {
      return fileNode.branchCount > best.branchCount ? fileNode : best;
    }
    return fileNode.reviewSectionCount > best.reviewSectionCount ? fileNode : best;
  }, null);

  if (!primaryFileNode) {
    return FALLBACK_TREE_VIEWPORT;
  }

  const preferredZoom = primaryFileNode.width > 1800 ? 0.82 : 0.92;
  const nodeFitZoom = Math.max(280, window.innerWidth - 32) / REVIEW_SECTION_WIDTH;
  const zoom = Math.max(MIN_TREE_ZOOM, Math.min(preferredZoom, nodeFitZoom));
  const primaryCenterX = primaryFileNode.x + primaryFileNode.width / 2;
  return {
    x: Math.round(window.innerWidth / 2 - primaryCenterX * zoom),
    y: Math.round(VIEWPORT_PADDING_Y - primaryFileNode.y * zoom),
    zoom,
  };
}

function fileReviewPriority(reviewPriority) {
  return FILE_REVIEW_PRIORITY.get(reviewPriority) ?? FILE_REVIEW_PRIORITY.size;
}

function fileChangeKindPriority(changeKind) {
  return FILE_CHANGE_KIND_PRIORITY.get(changeKind) ?? FILE_CHANGE_KIND_PRIORITY.size;
}

function layoutReviewSections(
  reviewSections,
  branches,
  getReviewSectionHeight = reviewSectionHeight,
) {
  const items = reviewSections.map((section, order) => ({
    height: getReviewSectionHeight(section),
    section,
    order,
    width: reviewSectionWidth(section),
  }));
  const layout = layoutTreeTopToBottom({
    branches,
    getId: (item) => item.section.id,
    items,
    layerGap: SECTION_TREE_LAYER_GAP_Y,
    siblingGap: SECTION_TREE_SIBLING_GAP_X,
  });

  return {
    height: layout.height,
    sections: layout.placements.map(({ item, x, y }) => ({
      height: item.height,
      section: item.section,
      x,
      y,
    })),
    width: Math.max(REVIEW_SECTION_WIDTH, layout.width),
  };
}

function reviewSectionHeight(reviewSection) {
  if (reviewSection.reviewGroup) {
    return REVIEW_GROUP_HEIGHT;
  }

  const lineCount = (reviewSection.codeChunks || []).reduce(
    (total, chunk) => total + (chunk.lines || []).length,
    0,
  );
  return Math.max(120, REVIEW_SECTION_HEADER_HEIGHT + lineCount * 18 + 2);
}

function reviewSectionWidth(reviewSection) {
  return reviewSection.reviewGroup ? REVIEW_GROUP_WIDTH : REVIEW_SECTION_WIDTH;
}

function reviewSectionId(file, reviewSectionIdValue) {
  return `${file.id}:${reviewSectionIdValue}`;
}

function fileNodeId(file) {
  return `file:${file.id}`;
}

export function sectionTreeSections(file) {
  return normalizeSectionTree(file).sections;
}
