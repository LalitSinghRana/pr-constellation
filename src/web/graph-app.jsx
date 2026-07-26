import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Braces,
  ChevronsDownUp,
  ChevronsUpDown,
  FileCode2,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Network,
  RotateCcw,
  UserRound,
} from "lucide-react";
import { JsonView, allExpanded, collapseAllNested, defaultStyles } from "react-json-view-lite";
import {
  Background,
  ControlButton,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { Badge } from "../../components/ui/badge.jsx";
import { Button } from "../../components/ui/button.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.jsx";

const FILE_PAGE_GAP_X = 160;
const FILE_PAGE_PADDING = 32;
const FILE_PAGE_PADDING_TOP = 72;
const FILE_PAGE_MIN_HEIGHT = 180;
const FILE_PAGE_STACK_GAP_Y = 56;
const MIDDLE_GROUP_PADDING = { bottom: 30, left: 28, right: 28, top: 54 };
const MIDDLE_TREE_LAYER_GAP_Y = 220;
const MIDDLE_TREE_SIBLING_GAP_X = 240;
const MINI_CODE_CHARACTER_COLUMNS = 120;
const MINI_CODE_CHARACTER_WIDTH = 7;
const MINI_DIFF_GUTTER_WIDTH = 102;
const MINI_DIFF_HORIZONTAL_PADDING = 18;
const MINI_NODE_WIDTH = (
  MINI_CODE_CHARACTER_COLUMNS * MINI_CODE_CHARACTER_WIDTH
  + MINI_DIFF_GUTTER_WIDTH
  + MINI_DIFF_HORIZONTAL_PADDING
);
const MINI_NODE_HEADER_HEIGHT = 58;
const MINI_TREE_LAYER_GAP_Y = 110;
const MINI_TREE_SIBLING_GAP_X = 72;
const MIN_GRAPH_ZOOM = 0.18;
const SUPER_GROUP_PADDING = { bottom: 64, left: 58, right: 58, top: 92 };
const SUPER_TREE_LAYER_GAP_Y = 280;
const SUPER_TREE_SIBLING_GAP_X = 320;
const VIEWPORT_PADDING_Y = 96;
const FALLBACK_GRAPH_VIEWPORT = { x: 72, y: 52, zoom: 0.86 };

const nodeTypes = {
  filePage: React.memo(FilePageNode),
  miniDiff: React.memo(MiniDiffNode),
};

function App() {
  const review = useMemo(readReviewData, []);
  const analysisSchema = useMemo(readAnalysisSchema, []);
  const analysisOutput = useMemo(readAnalysisOutput, []);
  const reactFlowData = useMemo(readReactFlowData, []);
  const diffHtml = useMemo(readDiffHtml, []);
  const hasGraph = Boolean((reactFlowData?.files || []).some((file) => miniTreeNodes(file).length > 0));
  const graph = useMemo(() => buildMiniDiffGraph(reactFlowData), [reactFlowData]);

  return (
    <Tabs className="review-shell" defaultValue={hasGraph ? "graph" : "diff"}>
      <ReviewHeader hasGraph={hasGraph} review={review} />
      <main className="review-tab-panels">
        <TabsContent className="review-tab-content graph-tab" value="graph">
          {hasGraph ? (
            <section className="graph-panel" aria-label="PR review tree">
              <ReactFlowProvider>
                <GraphCanvas graph={graph} />
              </ReactFlowProvider>
            </section>
          ) : (
            <section className="empty-panel">Review tree is not available for this run.</section>
          )}
        </TabsContent>
        <TabsContent className="review-tab-content diff-tab" value="diff">
          <div className="diff-scroll">
            <article className="diff-shell" dangerouslySetInnerHTML={{ __html: diffHtml }} />
          </div>
        </TabsContent>
        <TabsContent className="review-tab-content json-tab" forceMount value="json">
          <JsonWorkspace
            analysisOutput={analysisOutput}
            analysisSchema={analysisSchema}
            reactFlowGraph={graph}
          />
        </TabsContent>
      </main>
    </Tabs>
  );
}

function ReviewHeader({ hasGraph, review }) {
  return (
    <header className="review-header">
      <div className="review-header-main">
        <div className="review-title-row">
          <div className="review-eyebrow">
            <span className="review-mark">
              <GitPullRequest aria-hidden="true" size={16} />
            </span>
            <span>{`PR #${review.number || "unknown"}`}</span>
            <Badge className={`state-badge is-${String(review.state || "").toLowerCase()}`} variant="secondary">
              {review.state || "unknown"}
            </Badge>
          </div>
          <h1 className="review-title">
            <a href={review.url}>{review.title || "Untitled pull request"}</a>
          </h1>
          <TabsList aria-label="Review views" className="review-tabs-list">
            <TabsTrigger className="review-tab-trigger" disabled={!hasGraph} value="graph">
              <Network aria-hidden="true" size={15} />
              Tree
            </TabsTrigger>
            <TabsTrigger className="review-tab-trigger" value="diff">
              <FileDiff aria-hidden="true" size={15} />
              Diff
            </TabsTrigger>
            <TabsTrigger className="review-tab-trigger" value="json">
              <Braces aria-hidden="true" size={15} />
              JSON
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="review-meta">
          <Badge className="meta-chip branch-chip" title="Base and head branches" variant="outline">
            <GitBranch aria-hidden="true" size={14} />
            <span className="branch-name is-base">{review.baseRefName || "base"}</span>
            <span aria-hidden="true" className="branch-arrow">
              &lt;-
            </span>
            <span className="branch-name is-head">{review.headRefName || "head"}</span>
          </Badge>
          <Badge className="meta-chip author-chip" title="Author" variant="outline">
            <UserRound aria-hidden="true" size={14} />
            <span className="author-name">{review.authorLogin || "unknown"}</span>
          </Badge>
          <Badge className="change-pill is-add" variant="outline">
            +{review.additions ?? 0}
          </Badge>
          <Badge className="change-pill is-del" variant="outline">
            -{review.deletions ?? 0}
          </Badge>
        </div>
      </div>
    </header>
  );
}

function GraphCanvas({ graph }) {
  const reactFlow = useReactFlow();
  const defaultViewport = graph.defaultViewport || FALLBACK_GRAPH_VIEWPORT;

  return (
    <div className="flow-reader" data-flow-reader>
      <div className="flow-canvas">
        <ReactFlow
          colorMode="light"
          defaultEdges={graph.edges}
          defaultNodes={graph.nodes}
          defaultViewport={defaultViewport}
          maxZoom={1.7}
          minZoom={MIN_GRAPH_ZOOM}
          nodesConnectable={false}
          nodesDraggable={false}
          nodeTypes={nodeTypes}
          panOnDrag
          proOptions={{ hideAttribution: true }}
          selectNodesOnDrag={false}
          selectionOnDrag={false}
          zoomOnDoubleClick
          zoomOnPinch
          zoomOnScroll
        >
          <Background color="color-mix(in oklab, var(--primary) 16%, var(--border))" gap={28} size={1} />
          <Controls position="bottom-right" showFitView={false} showInteractive={false}>
            <ControlButton
              aria-label="Reset tree view"
              className="reset-view-button"
              onClick={() => reactFlow.setViewport(defaultViewport, { duration: 160 })}
              title="Reset tree view"
            >
              <RotateCcw aria-hidden="true" size={15} />
            </ControlButton>
          </Controls>
        </ReactFlow>
      </div>
    </div>
  );
}

function JsonWorkspace({ analysisOutput, analysisSchema, reactFlowGraph }) {
  return (
    <Tabs className="json-workspace" defaultValue="schema">
      <div className="json-toolbar">
        <TabsList aria-label="JSON documents" className="json-tabs-list">
          <TabsTrigger className="json-tab-trigger" value="schema">
            Output schema
          </TabsTrigger>
          <TabsTrigger className="json-tab-trigger" value="analysis">
            Analysis
          </TabsTrigger>
          <TabsTrigger className="json-tab-trigger" value="react-flow">
            React Flow
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent className="json-document-panel" forceMount value="schema">
        <JsonDocument data={analysisSchema} />
      </TabsContent>
      <TabsContent className="json-document-panel" forceMount value="analysis">
        <JsonDocument data={analysisOutput} />
      </TabsContent>
      <TabsContent className="json-document-panel" forceMount value="react-flow">
        <JsonDocument data={reactFlowGraph} />
      </TabsContent>
    </Tabs>
  );
}

function JsonDocument({ data }) {
  const [expansion, setExpansion] = useState({ mode: "collapsed", revision: 0 });
  const expandTree = () => {
    setExpansion((current) => ({ mode: "expanded", revision: current.revision + 1 }));
  };
  const collapseTree = () => {
    setExpansion((current) => ({ mode: "collapsed", revision: current.revision + 1 }));
  };

  return (
    <div className="json-document" data-json-document>
      <div aria-label="JSON tree controls" className="json-document-actions" role="toolbar">
        <Button
          aria-label="Expand entire JSON tree"
          aria-pressed={expansion.mode === "expanded"}
          className="json-tree-action"
          onClick={expandTree}
          size="icon-xs"
          title="Expand all"
          type="button"
          variant="ghost"
        >
          <ChevronsUpDown aria-hidden="true" />
        </Button>
        <Button
          aria-label="Collapse entire JSON tree"
          aria-pressed={expansion.mode === "collapsed"}
          className="json-tree-action"
          onClick={collapseTree}
          size="icon-xs"
          title="Collapse all"
          type="button"
          variant="ghost"
        >
          <ChevronsDownUp aria-hidden="true" />
        </Button>
      </div>
      <div className="json-document-scroll">
        <JsonView
          clickToExpandNode
          compactTopLevel
          data={data && typeof data === "object" ? data : {}}
          key={expansion.revision}
          shouldExpandNode={expansion.mode === "expanded" ? allExpanded : collapseAllNested}
          style={defaultStyles}
        />
      </div>
    </div>
  );
}

function FilePageNode({ data }) {
  const filePath = data.file?.path || "Unknown file";

  return (
    <section aria-label={`Mini-tree for ${filePath}`} className="file-page-node">
      <div className="file-page-label" title={filePath}>
        <FileCode2 aria-hidden="true" size={16} />
        <span>{filePath}</span>
      </div>
    </section>
  );
}

function MiniDiffNode({ data }) {
  const filePath = data.file?.path || "Unknown file";
  const reviewClass = data.miniNode.reviewClass || "unknown";
  const changeRole = data.miniNode.changeRole || "unknown";

  return (
    <article
      aria-label={`Code diff mini node for ${filePath}`}
      className="mini-diff-node nodrag nopan nowheel"
      data-file-path={filePath}
    >
      <Handle className="node-handle" position={Position.Top} type="target" />
      <header className="mini-diff-header">
        <span className="mini-diff-title" title={data.miniNode.title}>
          {data.miniNode.title}
        </span>
        <span className="mini-node-labels">
          <span className={`mini-node-label is-review-${reviewClass}`}>
            <span className="mini-node-label-key">reviewClass</span>
            <span className="mini-node-label-value">{reviewClass}</span>
          </span>
          <span className={`mini-node-label is-role-${changeRole}`}>
            <span className="mini-node-label-key">changeRole</span>
            <span className="mini-node-label-value">{changeRole}</span>
          </span>
        </span>
      </header>
      <div className="mini-diff-scroll">
        {(data.miniNode.codeChunks || []).map((chunk, chunkIndex) => (
          <pre className="code-diff mini-diff-code" key={`${data.miniNode.id}-${chunkIndex}`}>
            {(chunk.lines || []).map((line, lineIndex) => (
              <span className={`code-row mini-code-row is-${line.type}`} key={`${line.oldLine}-${line.newLine}-${lineIndex}`}>
                <span className="code-line-number">{line.oldLine ?? ""}</span>
                <span className="code-line-number">{line.newLine ?? ""}</span>
                <span className="code-prefix">{line.prefix}</span>
                <CodeContent line={line} />
              </span>
            ))}
          </pre>
        ))}
      </div>
      <Handle className="node-handle" position={Position.Bottom} type="source" />
    </article>
  );
}

function CodeContent({ line }) {
  if (line.highlightedHtml) {
    return (
      <span
        className="code-content shiki-inline-code"
        dangerouslySetInnerHTML={{ __html: line.highlightedHtml }}
      />
    );
  }

  return <span className="code-content">{line.content}</span>;
}

function buildMiniDiffGraph(analysis) {
  const nodes = [];
  const edges = [];
  const filePages = [];
  const fileSpecs = buildFilePageSpecs(analysis);

  for (const spec of fileSpecs) {
    const { file, miniNodes, miniTree, pageHeight, pageId, pageWidth, x, y } = spec;
    if (miniNodes.length === 0) {
      continue;
    }

    const layout = spec.layout;

    nodes.push({
      id: pageId,
      data: { file },
      draggable: false,
      position: { x, y },
      selectable: false,
      style: { height: pageHeight, width: pageWidth },
      type: "filePage",
    });
    filePages.push({
      edgeCount: miniTree.edges.length,
      height: pageHeight,
      miniNodeCount: miniNodes.length,
      width: pageWidth,
      x,
      y,
    });

    for (const item of layout.nodes) {
      nodes.push({
        id: miniNodeId(file, item.node.id),
        data: {
          file,
          miniNode: item.node,
        },
        draggable: false,
        extent: "parent",
        parentId: pageId,
        position: {
          x: FILE_PAGE_PADDING + item.x,
          y: FILE_PAGE_PADDING_TOP + item.y,
        },
        selectable: false,
        style: { width: MINI_NODE_WIDTH },
        type: "miniDiff",
      });
    }

    const validMiniNodeIds = new Set(miniNodes.map((miniNode) => miniNode.id));
    for (const edge of miniTree.edges) {
      if (!validMiniNodeIds.has(edge.from) || !validMiniNodeIds.has(edge.to)) {
        continue;
      }

      edges.push({
        id: `${file.id}:${edge.from}->${edge.to}`,
        className: "mini-tree-edge",
        markerEnd: {
          color: "var(--mini-tree-color)",
          height: 18,
          type: MarkerType.ArrowClosed,
          width: 18,
        },
        source: miniNodeId(file, edge.from),
        style: {
          stroke: "var(--mini-tree-color)",
          strokeLinecap: "round",
          strokeOpacity: 0.8,
          strokeWidth: 4,
        },
        target: miniNodeId(file, edge.to),
        type: "smoothstep",
        zIndex: 4,
      });
    }
  }

  return {
    defaultViewport: defaultViewportForPages(filePages),
    edges,
    nodes,
  };
}

function buildFilePageSpecs(analysis) {
  const fileLayouts = (analysis?.files || [])
    .filter((file) => miniTreeNodes(file).length > 0)
    .map(buildFileLayout);

  return layoutIndependentFilePages(fileLayouts);
}

function layoutIndependentFilePages(fileLayouts) {
  if (fileLayouts.length === 0) {
    return [];
  }

  const columns = Math.min(3, Math.ceil(Math.sqrt(fileLayouts.length)));
  const rows = Math.ceil(fileLayouts.length / columns);
  const columnWidths = Array.from({ length: columns }, () => 0);
  const rowHeights = Array.from({ length: rows }, () => 0);

  fileLayouts.forEach((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column], item.pageWidth);
    rowHeights[row] = Math.max(rowHeights[row], item.pageHeight);
  });

  const columnX = [];
  const rowY = [];
  let cursorX = 0;
  let cursorY = 0;

  for (const width of columnWidths) {
    columnX.push(cursorX);
    cursorX += width + FILE_PAGE_GAP_X;
  }

  for (const height of rowHeights) {
    rowY.push(cursorY);
    cursorY += height + FILE_PAGE_STACK_GAP_Y * 3;
  }

  return fileLayouts.map((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);

    return {
      ...item,
      x: columnX[column] + (columnWidths[column] - item.pageWidth) / 2,
      y: rowY[row],
    };
  });
}

function buildSuperGroupLayouts(analysis, fileById) {
  const layouts = [];

  for (const [superOrder, superNode] of (analysis?.superTree?.nodes || []).entries()) {
    const middleLayouts = [];

    for (const [treeOrder, treeNode] of (superNode.tree?.nodes || []).entries()) {
      const files = (treeNode.codeRefs?.fileIds || [])
        .map((fileId) => fileById.get(fileId))
        .filter((file) => file && miniTreeNodes(file).length > 0);

      if (files.length > 0) {
        middleLayouts.push(buildMiddleGroupLayout({
          files,
          order: treeOrder,
          superNode,
          treeNode,
        }));
      }
    }

    if (middleLayouts.length === 0) {
      continue;
    }

    const middleTreeLayout = layoutMiddleGroupsTopToBottom(
      middleLayouts,
      superNode.tree?.edges || [],
    );
    const localFileSpecs = middleTreeLayout.placements.flatMap((placement) => {
      return placement.item.fileSpecs.map((spec) => ({
        ...spec,
        x: placement.x + spec.x,
        y: placement.y + spec.y,
      }));
    });
    const superBounds = boundsForSpecs(localFileSpecs, SUPER_GROUP_PADDING);

    layouts.push({
      depth: Number.isFinite(superNode.depth) ? superNode.depth : superOrder,
      fileSpecs: localFileSpecs.map((spec) => ({
        ...spec,
        x: spec.x - superBounds.x,
        y: spec.y - superBounds.y,
      })),
      height: superBounds.height,
      order: superOrder,
      superNode,
      width: superBounds.width,
    });
  }

  return layouts;
}

function buildMiddleGroupLayout({ files, order, superNode, treeNode }) {
  const fileLayouts = files.map(buildFileLayout);
  const contentWidth = Math.max(
    ...fileLayouts.map((item) => item.pageWidth),
    MINI_NODE_WIDTH + FILE_PAGE_PADDING * 2,
  );
  const contentHeight = fileLayouts.reduce((total, item, index) => {
    return total + item.pageHeight + (index > 0 ? FILE_PAGE_STACK_GAP_Y : 0);
  }, 0);
  let cursorY = MIDDLE_GROUP_PADDING.top;
  const fileSpecs = fileLayouts.map((item) => {
    const spec = {
      ...item,
      superNode,
      treeNode,
      treeNodeId: treeNode.id,
      x: MIDDLE_GROUP_PADDING.left + (contentWidth - item.pageWidth) / 2,
      y: cursorY,
    };
    cursorY += item.pageHeight + FILE_PAGE_STACK_GAP_Y;
    return spec;
  });

  return {
    depth: Number.isFinite(treeNode.depth) ? treeNode.depth : order,
    fileSpecs,
    height: contentHeight + MIDDLE_GROUP_PADDING.top + MIDDLE_GROUP_PADDING.bottom,
    order,
    treeNode,
    width: contentWidth + MIDDLE_GROUP_PADDING.left + MIDDLE_GROUP_PADDING.right,
  };
}

function buildFileLayout(file) {
  const miniTree = {
    edges: miniTreeEdges(file),
    nodes: miniTreeNodes(file),
  };
  const miniNodes = miniTree.nodes;
  const layout = layoutMiniNodes(miniNodes, miniTree.edges);

  return {
    file,
    layout,
    miniNodes,
    miniTree,
    pageHeight: Math.max(
      FILE_PAGE_MIN_HEIGHT,
      FILE_PAGE_PADDING_TOP + layout.height + FILE_PAGE_PADDING,
    ),
    pageId: filePageId(file),
    pageWidth: FILE_PAGE_PADDING * 2 + layout.width,
  };
}

function layoutMiddleGroupsTopToBottom(items, edges) {
  return layoutGroupsTopToBottom({
    edges,
    getId: (item) => item.treeNode.id,
    items,
    layerGap: MIDDLE_TREE_LAYER_GAP_Y,
    siblingGap: MIDDLE_TREE_SIBLING_GAP_X,
  });
}

function layoutSuperGroupsTopToBottom(items, edges) {
  return layoutGroupsTopToBottom({
    edges,
    getId: (item) => item.superNode.id,
    items,
    layerGap: SUPER_TREE_LAYER_GAP_Y,
    siblingGap: SUPER_TREE_SIBLING_GAP_X,
  });
}

function layoutGroupsTopToBottom({ edges, getId, items, layerGap, siblingGap }) {
  if (items.length === 0) {
    return { height: 0, placements: [], width: 0 };
  }

  const itemById = new Map(items.map((item) => [getId(item), item]));
  const childrenById = new Map(items.map((item) => [getId(item), []]));
  const incomingIds = new Set();

  for (const edge of edges) {
    if (
      edge.from === edge.to
      || !itemById.has(edge.from)
      || !itemById.has(edge.to)
      || incomingIds.has(edge.to)
    ) {
      continue;
    }

    childrenById.get(edge.from).push(edge.to);
    incomingIds.add(edge.to);
  }

  for (const children of childrenById.values()) {
    children.sort((leftId, rightId) => {
      return itemById.get(leftId).order - itemById.get(rightId).order;
    });
  }

  const roots = items
    .filter((item) => !incomingIds.has(getId(item)))
    .sort((left, right) => left.order - right.order);
  const orderedRoots = roots.length > 0
    ? roots
    : items.slice().sort((left, right) => left.order - right.order);
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

function buildHierarchyGroupNodes(fileSpecs) {
  const middleSpecs = groupSpecsBy(fileSpecs, (spec) => {
    if (!spec.superNode?.id || !spec.treeNode?.id) {
      return null;
    }
    return `${spec.superNode.id}:${spec.treeNode.id}`;
  });
  const superSpecs = groupSpecsBy(fileSpecs, (spec) => spec.superNode?.id || null);
  const middleNodeIds = new Set();
  const superNodeIds = new Set();
  const bounds = [];
  const nodes = [];

  for (const specs of middleSpecs.values()) {
    const { superNode, treeNode } = specs[0];
    const id = middleGroupId(superNode.id, treeNode.id);
    const rect = boundsForSpecs(specs, MIDDLE_GROUP_PADDING);

    middleNodeIds.add(id);
    bounds.push(rect);
    nodes.push({
      id,
      data: {
        level: "middle",
        title: treeNode.title || "File group",
      },
      draggable: false,
      position: { x: rect.x, y: rect.y },
      selectable: false,
      style: { height: rect.height, width: rect.width },
      type: "hierarchyGroup",
      zIndex: 1,
    });
  }

  for (const specs of superSpecs.values()) {
    const { superNode } = specs[0];
    const id = superGroupId(superNode.id);
    const rect = boundsForSpecs(specs, SUPER_GROUP_PADDING);

    superNodeIds.add(id);
    bounds.push(rect);
    nodes.push({
      id,
      data: {
        level: "super",
        title: superNode.title || "Review group",
      },
      draggable: false,
      position: { x: rect.x, y: rect.y },
      selectable: false,
      style: { height: rect.height, width: rect.width },
      type: "hierarchyGroup",
      zIndex: 0,
    });
  }

  return { bounds, middleNodeIds, nodes, superNodeIds };
}

function groupSpecsBy(specs, keyForSpec) {
  const groups = new Map();

  for (const spec of specs) {
    const key = keyForSpec(spec);
    if (!key) {
      continue;
    }

    const group = groups.get(key) || [];
    group.push(spec);
    groups.set(key, group);
  }

  return groups;
}

function boundsForSpecs(specs, padding) {
  const minX = Math.min(...specs.map((spec) => spec.x));
  const minY = Math.min(...specs.map((spec) => spec.y));
  const maxX = Math.max(...specs.map((spec) => spec.x + spec.pageWidth));
  const maxY = Math.max(...specs.map((spec) => spec.y + spec.pageHeight));

  return {
    height: maxY - minY + padding.top + padding.bottom,
    width: maxX - minX + padding.left + padding.right,
    x: minX - padding.left,
    y: minY - padding.top,
  };
}

function buildMiddleTreeEdges(analysis, middleNodeIds) {
  const edges = [];

  for (const superNode of analysis?.superTree?.nodes || []) {
    for (const edge of superNode.tree?.edges || []) {
      const source = middleGroupId(superNode.id, edge.from);
      const target = middleGroupId(superNode.id, edge.to);

      if (!middleNodeIds.has(source) || !middleNodeIds.has(target)) {
        continue;
      }

      edges.push({
        id: `middle:${superNode.id}:${edge.from}->${edge.to}`,
        className: "middle-tree-edge",
        markerEnd: {
          color: "var(--middle-tree-color)",
          height: 22,
          type: MarkerType.ArrowClosed,
          width: 22,
        },
        source,
        style: {
          stroke: "var(--middle-tree-color)",
          strokeLinecap: "round",
          strokeOpacity: 0.74,
          strokeWidth: 7,
        },
        target,
        type: "smoothstep",
        zIndex: 2,
      });
    }
  }

  return edges;
}

function buildSuperTreeEdges(analysis, superNodeIds) {
  const edges = [];

  for (const edge of analysis?.superTree?.edges || []) {
    const source = superGroupId(edge.from);
    const target = superGroupId(edge.to);

    if (!superNodeIds.has(source) || !superNodeIds.has(target)) {
      continue;
    }

    edges.push({
      id: `super:${edge.from}->${edge.to}`,
      className: "super-tree-edge",
      markerEnd: {
        color: "var(--super-tree-color)",
        height: 26,
        type: MarkerType.ArrowClosed,
        width: 26,
      },
      source,
      style: {
        stroke: "var(--super-tree-color)",
        strokeLinecap: "round",
        strokeOpacity: 0.68,
        strokeWidth: 10,
      },
      target,
      type: "smoothstep",
      zIndex: 1,
    });
  }

  return edges;
}

function defaultViewportForPages(filePages) {
  const primaryPage = filePages.reduce((best, page) => {
    if (!best) {
      return page;
    }
    if (page.edgeCount !== best.edgeCount) {
      return page.edgeCount > best.edgeCount ? page : best;
    }
    return page.miniNodeCount > best.miniNodeCount ? page : best;
  }, null);

  if (!primaryPage) {
    return FALLBACK_GRAPH_VIEWPORT;
  }

  const preferredZoom = primaryPage.width > 1800 ? 0.82 : 0.92;
  const nodeFitZoom = Math.max(280, window.innerWidth - 32) / MINI_NODE_WIDTH;
  const zoom = Math.max(MIN_GRAPH_ZOOM, Math.min(preferredZoom, nodeFitZoom));
  const primaryCenterX = primaryPage.x + primaryPage.width / 2;
  return {
    x: Math.round(window.innerWidth / 2 - primaryCenterX * zoom),
    y: Math.round(VIEWPORT_PADDING_Y - primaryPage.y * zoom),
    zoom,
  };
}

function layoutMiniNodes(miniNodes, miniEdges) {
  const items = miniNodes.map((node, order) => ({
    height: miniNodeHeight(node),
    node,
    order,
    width: MINI_NODE_WIDTH,
  }));
  const layout = layoutGroupsTopToBottom({
    edges: miniEdges,
    getId: (item) => item.node.id,
    items,
    layerGap: MINI_TREE_LAYER_GAP_Y,
    siblingGap: MINI_TREE_SIBLING_GAP_X,
  });

  return {
    height: layout.height,
    nodes: layout.placements.map(({ item, x, y }) => ({
      node: item.node,
      x,
      y,
    })),
    width: Math.max(MINI_NODE_WIDTH, layout.width),
  };
}

function miniNodeHeight(miniNode) {
  const lineCount = (miniNode.codeChunks || []).reduce((total, chunk) => total + (chunk.lines || []).length, 0);
  return Math.max(120, MINI_NODE_HEADER_HEIGHT + lineCount * 18 + 2);
}

function miniNodeId(file, miniNodeIdValue) {
  return `${file.id}:${miniNodeIdValue}`;
}

function filePageId(file) {
  return `file:${file.id}`;
}

function middleGroupId(superNodeId, treeNodeId) {
  return `middle-group:${superNodeId}:${treeNodeId}`;
}

function superGroupId(superNodeId) {
  return `super-group:${superNodeId}`;
}

function miniTreeNodes(file) {
  return file?.miniTree?.nodes || file?.miniNodes || [];
}

function miniTreeEdges(file) {
  return file?.miniTree?.edges || file?.miniEdges || [];
}

function readReviewData() {
  return readJsonScript("pr-review-data", {});
}

function readAnalysisSchema() {
  return readJsonScript("pr-analysis-schema", {});
}

function readAnalysisOutput() {
  return readJsonScript("pr-analysis-output", null);
}

function readReactFlowData() {
  return readJsonScript("pr-analysis-data", null);
}

function readDiffHtml() {
  return readJsonScript("pr-diff-html", "");
}

function readJsonScript(id, fallback) {
  const target = document.getElementById(id);
  if (!target) {
    return fallback;
  }
  return JSON.parse(target.textContent);
}

const root = createRoot(document.getElementById("pr-review-root"));
root.render(<App />);
