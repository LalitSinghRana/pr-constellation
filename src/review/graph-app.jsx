import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import {
  Braces,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileDiff,
  FolderTree,
  GitBranch,
  GitPullRequest,
  MessageSquareText,
  Network,
  RotateCcw,
  UserRound,
} from "lucide-react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { JsonView, allExpanded, collapseAllNested, defaultStyles } from "react-json-view-lite";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ControlButton,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useNodes,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Collapsible, CollapsibleTrigger } from "../components/ui/collapsible.jsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.jsx";
import { foldMiniTree, normalizeMiniTree } from "./mini-tree-model.js";

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
const MINI_TREE_GROUP_NODE_HEIGHT = 118;
const MINI_TREE_GROUP_NODE_WIDTH = 520;
const MINI_TREE_LAYER_GAP_Y = 110;
const MINI_TREE_SIBLING_GAP_X = 72;
const MIN_GRAPH_ZOOM = 0.18;
const SUPER_GROUP_PADDING = { bottom: 64, left: 58, right: 58, top: 92 };
const SUPER_TREE_LAYER_GAP_Y = 280;
const SUPER_TREE_SIBLING_GAP_X = 320;
const VIEWPORT_PADDING_Y = 96;
const FALLBACK_GRAPH_VIEWPORT = { x: 72, y: 52, zoom: 0.86 };
const FILE_REVIEW_CLASS_PRIORITY = new Map([
  ["important", 0],
  ["supporting", 1],
  ["mechanical", 2],
]);
const FILE_CHANGE_ROLE_PRIORITY = new Map([
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

const nodeTypes = {
  collapsedGroup: React.memo(CollapsedReviewGroupNode),
  filePage: React.memo(FilePageNode),
  miniDiff: React.memo(MiniDiffNode),
};
const edgeTypes = {
  reviewExplanation: React.memo(ReviewExplanationEdge),
};

function App() {
  const review = useMemo(readReviewData, []);
  const analysisSchema = useMemo(readAnalysisSchema, []);
  const analysisOutput = useMemo(readAnalysisOutput, []);
  const reactFlowData = useMemo(readReactFlowData, []);
  const diffHtml = useMemo(readDiffHtml, []);
  const hasGraph = Boolean((reactFlowData?.files || []).some((file) => miniTreeNodes(file).length > 0));
  const expansionStorageKey = useMemo(() => {
    return `pr-review-tree-expansion:${window.location.pathname}`;
  }, []);
  const fileOrderViewStorageKey = useMemo(() => {
    return `pr-review-file-order-view:${window.location.pathname}`;
  }, []);
  const [expandedGroupIds, setExpandedGroupIds] = usePersistentStringSet(expansionStorageKey);
  const [fileOrderViewIds, setFileOrderViewIds] = usePersistentStringSet(fileOrderViewStorageKey);
  const stacks = reactFlowData?.reviewStack?.stacks || [];
  const [activeStackId, setActiveStackId] = useState(() => stacks[0]?.id ?? null);
  // First-pass layout uses the estimated miniNodeHeight() formula; once
  // GraphCanvas measures real rendered heights that drift from the estimate,
  // this re-runs layout with real numbers. Node ids are globally unique and
  // content is static, so measurements never need to be invalidated.
  const [measuredHeights, setMeasuredHeights] = useState(() => new Map());
  const handleMeasuredHeightsChange = useCallback((updates) => {
    setMeasuredHeights((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [id, height] of updates) {
        if (next.get(id) !== height) {
          next.set(id, height);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);
  const graph = useMemo(() => {
    // Always scope the canvas to one stack at a time, even when there is
    // only one: review stacks render independently, never as one combined
    // whole-PR graph. Falls back to unfiltered only for old runs with no
    // reviewStack at all (activeStackId stays null in that case).
    return buildMiniDiffGraph(reactFlowData, {
      activeStackId,
      expandedGroupIds,
      fileOrderViewIds,
      measuredHeights,
    });
  }, [activeStackId, expandedGroupIds, fileOrderViewIds, measuredHeights, reactFlowData]);
  const toggleCollapsedGroup = useCallback((groupId) => {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, [setExpandedGroupIds]);
  const setFileViewMode = useCallback((fileId, viewMode) => {
    setFileOrderViewIds((current) => {
      const next = new Set(current);
      if (viewMode === "file") {
        next.add(fileId);
      } else {
        next.delete(fileId);
      }
      return next;
    });
  }, [setFileOrderViewIds]);

  return (
    <Tabs className="review-shell" defaultValue={hasGraph ? "graph" : "diff"}>
      <ReviewHeader hasGraph={hasGraph} review={review} />
      <main className="review-tab-panels">
        <TabsContent className="review-tab-content graph-tab" value="graph">
          {hasGraph ? (
            <section className="graph-panel" aria-label="PR review tree">
              <ReactFlowProvider>
                <GraphCanvas
                  activeStackId={activeStackId}
                  graph={graph}
                  onActiveStackChange={setActiveStackId}
                  onFileViewModeChange={setFileViewMode}
                  onMeasuredHeightsChange={handleMeasuredHeightsChange}
                  onToggleCollapsedGroup={toggleCollapsedGroup}
                  stacks={stacks}
                />
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

function GraphCanvas({
  activeStackId,
  graph,
  onActiveStackChange,
  onFileViewModeChange,
  onMeasuredHeightsChange,
  onToggleCollapsedGroup,
  stacks,
}) {
  const reactFlow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const liveNodes = useNodes();
  const defaultViewport = graph.defaultViewport || FALLBACK_GRAPH_VIEWPORT;
  useEffect(() => {
    reactFlow.setViewport(defaultViewport, { duration: 200 });
    // Re-center whenever the selected stack changes; not on every viewport
    // recompute, since that would fight the user's own pan/zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStackId]);
  useEffect(() => {
    if (!nodesInitialized) {
      return;
    }

    const updates = new Map();
    for (const node of liveNodes) {
      if (node.type !== "miniDiff" || !node.measured?.height || !node.data?.miniNode) {
        continue;
      }
      const estimatedHeight = miniNodeHeight(node.data.miniNode);
      if (Math.abs(node.measured.height - estimatedHeight) > 2) {
        updates.set(node.id, node.measured.height);
      }
    }

    if (updates.size > 0) {
      onMeasuredHeightsChange(updates);
    }
  }, [liveNodes, nodesInitialized, onMeasuredHeightsChange]);
  const interactiveNodes = useMemo(() => {
    return graph.nodes.map((node) => {
      if (node.type === "collapsedGroup") {
        return {
          ...node,
          data: {
            ...node.data,
            onToggleCollapsedGroup,
          },
        };
      }

      if (node.type === "filePage") {
        return {
          ...node,
          data: {
            ...node.data,
            onFileViewModeChange,
          },
        };
      }

      return node;
    });
  }, [graph.nodes, onFileViewModeChange, onToggleCollapsedGroup]);
  return (
    <div className="flow-reader" data-flow-reader>
      <div className="flow-canvas">
        <ReactFlow
          colorMode="light"
          defaultViewport={defaultViewport}
          edges={graph.edges}
          edgeTypes={edgeTypes}
          maxZoom={1.7}
          minZoom={MIN_GRAPH_ZOOM}
          nodesConnectable={false}
          nodesDraggable={false}
          nodes={interactiveNodes}
          nodeTypes={nodeTypes}
          panOnDrag={[1, 2]}
          panOnScroll
          panOnScrollMode="free"
          proOptions={{ hideAttribution: true }}
          selectNodesOnDrag={false}
          selectionOnDrag={false}
          zoomOnDoubleClick
          zoomOnPinch
          zoomOnScroll={false}
        >
          <Background
            bgColor="color-mix(in oklab, var(--muted) 34%, var(--background))"
            color="color-mix(in oklab, var(--mini-tree-color) 24%, var(--border))"
            gap={24}
            size={1.2}
            variant={BackgroundVariant.Dots}
          />
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
        <StackSelect activeStackId={activeStackId} onActiveStackChange={onActiveStackChange} stacks={stacks} />
      </div>
    </div>
  );
}

function StackSelect({ activeStackId, onActiveStackChange, stacks }) {
  if (stacks.length < 2) {
    return null;
  }

  return (
    <Select onValueChange={onActiveStackChange} value={activeStackId ?? undefined}>
      <SelectTrigger aria-label="Review stack" className="stack-select-trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {stacks.map((stack) => (
          <SelectItem key={stack.id} value={stack.id}>
            {stack.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  const viewMode = data.viewMode === "file" ? "file" : "tree";
  const fileComment = data.file?.comment || "";

  return (
    <section aria-label={`Mini-tree for ${filePath}`} className="file-page-node">
      <div className="file-page-header">
        <ExplanationHoverCard
          comment={fileComment}
          contextLabel="File: What / Why"
          side="bottom"
          title={filePath}
        >
          <Badge
            className="file-page-label"
            data-has-explanation={Boolean(fileComment)}
            tabIndex={fileComment ? 0 : undefined}
            title={filePath}
            variant="outline"
          >
            <FileCode2 aria-hidden="true" size={16} />
            <span>{filePath}</span>
          </Badge>
        </ExplanationHoverCard>
        <Tabs
          className="file-page-view-tabs nodrag nopan"
          onValueChange={(nextMode) => data.onFileViewModeChange?.(data.file.id, nextMode)}
          value={viewMode}
        >
          <TabsList aria-label={`${filePath} view`} className="file-page-view-tabs-list">
            <TabsTrigger className="file-page-view-tab" value="tree">
              <Network aria-hidden="true" size={14} />
              Tree
            </TabsTrigger>
            <TabsTrigger className="file-page-view-tab" value="file">
              <FileDiff aria-hidden="true" size={14} />
              File
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </section>
  );
}

function CollapsedReviewGroupNode({ data }) {
  const group = data.miniNode.collapsedGroup;
  const action = group.expanded ? "Collapse" : "Expand";
  const rootPreview = group.rootTitles.slice(0, 3).join(", ");

  return (
    <ExplanationHoverCard
      comment={data.miniNode.comment}
      contextLabel="Node group: What / Why"
      title={data.miniNode.title}
    >
      <Collapsible
        asChild
        onOpenChange={(expanded) => {
          if (expanded !== group.expanded) {
            data.onToggleCollapsedGroup(group.groupId);
          }
        }}
        open={group.expanded}
      >
        <article className={`collapsed-review-group is-${data.miniNode.reviewClass} nodrag nopan`}>
          <Handle className="node-handle" position={Position.Top} type="target" />
          <CollapsibleTrigger asChild>
            <Button
              aria-label={`${action} ${data.miniNode.title}`}
              className="collapsed-review-group-button"
              title={`${action}: ${rootPreview}`}
              type="button"
              variant="ghost"
            >
              <span className="collapsed-review-group-icon">
                <FolderTree aria-hidden="true" size={20} />
              </span>
              <span className="collapsed-review-group-copy">
                <span className="collapsed-review-group-title">{data.miniNode.title}</span>
                <span className="collapsed-review-group-summary">
                  {`${group.subtreeCount} ${group.subtreeCount === 1 ? "subtree" : "subtrees"} · ${group.nodeCount} nodes · ${group.lineCount} changed lines`}
                </span>
                <span className="collapsed-review-group-preview">{rootPreview}</span>
              </span>
              <span className="collapsed-review-group-toggle">
                {group.expanded
                  ? <ChevronDown aria-hidden="true" size={19} />
                  : <ChevronRight aria-hidden="true" size={19} />}
              </span>
            </Button>
          </CollapsibleTrigger>
          <Handle className="node-handle" position={Position.Bottom} type="source" />
        </article>
      </Collapsible>
    </ExplanationHoverCard>
  );
}

function MiniDiffNode({ data }) {
  const filePath = data.file?.path || "Unknown file";
  const reviewClass = data.miniNode.reviewClass || "unknown";
  const changeRole = data.miniNode.changeRole || "unknown";
  const showHandles = !data.miniNode.fileOrderView;

  const nodeComment = data.miniNode.comment || "";

  return (
    <article
      aria-label={`Code diff mini node for ${filePath}: ${data.miniNode.title}. ${plainTextComment(nodeComment)}`}
      className="mini-diff-node nodrag nopan"
      data-file-path={filePath}
    >
      {showHandles ? <Handle className="node-handle" position={Position.Top} type="target" /> : null}
      <ExplanationHoverCard
        comment={nodeComment}
        contextLabel="Node: What / Why"
        title={data.miniNode.title}
      >
        <header
          aria-label={`What and why for ${data.miniNode.title}. ${plainTextComment(nodeComment)}`}
          className="mini-diff-header"
          tabIndex={nodeComment ? 0 : undefined}
        >
          <span className="mini-diff-title" title={data.miniNode.title}>
            {data.miniNode.title}
          </span>
          <span className="mini-node-labels">
            {nodeComment ? (
              <MessageSquareText
                aria-label="What and why explanation available"
                className="mini-node-comment-indicator"
                size={15}
              />
            ) : null}
            <Badge className={`mini-node-label is-review-${reviewClass}`} variant="outline">
              <span className="mini-node-label-key">reviewClass</span>
              <span className="mini-node-label-value">{reviewClass}</span>
            </Badge>
            <Badge className={`mini-node-label is-role-${changeRole}`} variant="outline">
              <span className="mini-node-label-key">changeRole</span>
              <span className="mini-node-label-value">{changeRole}</span>
            </Badge>
          </span>
        </header>
      </ExplanationHoverCard>
      <div className="mini-diff-scroll">
        {(data.miniNode.codeChunks || []).map((chunk, chunkIndex, chunks) => (
          <React.Fragment key={`${data.miniNode.id}-${chunkIndex}`}>
            <UnchangedLinesGap nextChunk={chunk} prevChunk={chunks[chunkIndex - 1]} />
            <DiffChunkView chunk={chunk} />
          </React.Fragment>
        ))}
      </div>
      {showHandles ? <Handle className="node-handle" position={Position.Bottom} type="source" /> : null}
    </article>
  );
}

function ReviewExplanationEdge({
  data,
  id,
  markerEnd,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY,
}) {
  const [edgePath] = getSmoothStepPath({
    borderRadius: 14,
    offset: 20,
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });
  const comment = data?.comment || "";
  const sourceTitle = data?.sourceTitle || "Source node";
  const targetTitle = data?.targetTitle || "Target node";

  return (
    <ExplanationHoverCard
      comment={comment}
      contextLabel="Review edge: What / Why"
      side="top"
      title={`${sourceTitle} → ${targetTitle}`}
    >
      <g
        aria-label={`${sourceTitle} to ${targetTitle}. ${plainTextComment(comment)}`}
        className="comment-edge-trigger"
        role="note"
        tabIndex={comment ? 0 : undefined}
      >
        <BaseEdge
          className="comment-edge-path"
          id={id}
          interactionWidth={0}
          markerEnd={markerEnd}
          path={edgePath}
          style={style}
        />
        <path aria-hidden="true" className="comment-edge-hit-path" d={edgePath} />
      </g>
    </ExplanationHoverCard>
  );
}

function ExplanationHoverCard({
  children,
  comment,
  contextLabel,
  side = "top",
  title,
}) {
  const explanation = String(comment || "").trim();
  if (!explanation) {
    return children;
  }

  return (
    <HoverCard closeDelay={120} openDelay={220}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="explanation-hover-card nodrag nopan nowheel"
        side={side}
        sideOffset={10}
      >
        <div className="explanation-hover-label">{contextLabel}</div>
        <div className="explanation-hover-title">{title}</div>
        <div className="explanation-hover-comment">
          <ReactMarkdown>{explanation}</ReactMarkdown>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function plainTextComment(comment) {
  return String(comment || "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function UnchangedLinesGap({ nextChunk, prevChunk }) {
  const gap = unchangedLineGap(prevChunk, nextChunk);

  if (!gap) {
    return null;
  }

  return <div className="mini-diff-gap-divider">⋯ {gap} unchanged lines</div>;
}

function unchangedLineGap(prevChunk, nextChunk) {
  const prevLine = prevChunk?.lines?.at(-1);
  const nextLine = nextChunk?.lines?.[0];

  if (prevLine?.oldLine == null || nextLine?.oldLine == null) {
    return 0;
  }

  return Math.max(0, nextLine.oldLine - prevLine.oldLine - 1);
}

function DiffChunkView({ chunk }) {
  const { data, registerHighlighter } = useMemo(() => buildChunkDiffData(chunk), [chunk]);

  return (
    <DiffView
      className="mini-diff-code"
      data={data}
      diffViewFontSize={11}
      diffViewHighlight
      diffViewMode={DiffModeEnum.Unified}
      diffViewWrap={false}
      registerHighlighter={registerHighlighter}
    />
  );
}

function buildChunkDiffData(chunk) {
  const lines = chunk.lines || [];
  const oldLines = lines.filter((line) => line.type !== "add");
  const newLines = lines.filter((line) => line.type !== "del");
  const oldFileContent = oldLines.map((line) => line.content).join("\n");
  const newFileContent = newLines.map((line) => line.content).join("\n");
  // oldFile/newFile.content IS the whole synthetic "file" handed to the library, so the
  // hunk must claim to start at line 1 on each side (its own line count), not the real PR
  // line number — the library indexes hunk positions against the given content's own
  // length, and a real (larger) line number here makes it fall back to an empty diff.
  const oldStart = oldLines.length > 0 ? 1 : 0;
  const newStart = newLines.length > 0 ? 1 : 0;
  const hunkHeader = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`;
  const hunkBody = lines
    .map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.content}`)
    .join("\n");
  // The parser also looks for a "--- a/... \n+++ b/..." file header before it will read any
  // "@@ ... @@" hunks; without it every hunk is silently discarded as an empty diff.
  const hunkText = `--- a/${chunk.file}\n+++ b/${chunk.file}\n${hunkHeader}\n${hunkBody}`;

  return {
    data: {
      hunks: [hunkText],
      newFile: { content: newFileContent, fileLang: "plaintext", fileName: chunk.file },
      oldFile: { content: oldFileContent, fileLang: "plaintext", fileName: chunk.file },
    },
    registerHighlighter: createPreHighlightedHighlighter({
      newAst: { children: buildLineAstNodes(newLines), type: "root" },
      newFileContent,
      oldAst: { children: buildLineAstNodes(oldLines), type: "root" },
      oldFileContent,
    }),
  };
}

function buildLineAstNodes(lines) {
  const children = [];

  lines.forEach((line, index) => {
    children.push(...tokensToAstNodes(line.syntaxTokens));

    if (index < lines.length - 1) {
      children.push({ type: "text", value: "\n" });
    }
  });

  return children;
}

function tokensToAstNodes(tokens) {
  return (tokens || []).map((token) => (
    token.style
      ? {
          children: [{ type: "text", value: token.content }],
          properties: { style: token.style },
          tagName: "span",
          type: "element",
        }
      : { type: "text", value: token.content }
  ));
}

// The shiki tokens are highlighted server-side (render.js); this highlighter just hands
// pre-built per-file ASTs back to @git-diff-view/react instead of running a highlighter
// engine (e.g. lowlight) in the browser.
function createPreHighlightedHighlighter({ newAst, newFileContent, oldAst, oldFileContent }) {
  return {
    getAST: (raw) => (raw === newFileContent ? newAst : oldAst),
    hasRegisteredCurrentLang: () => true,
    ignoreSyntaxHighlightList: [],
    maxLineToIgnoreSyntax: Number.POSITIVE_INFINITY,
    name: "pre-highlighted",
    processAST: processPreHighlightedAst,
    setIgnoreSyntaxHighlightList: () => {},
    setMaxLineToIgnoreSyntax: () => {},
    type: "style",
  };
}

// Splits a per-file AST (built by buildLineAstNodes) into per-line syntax records.
// Adapted from @git-diff-view/lowlight's processAST: line breaks are detected purely
// from literal "\n" characters inside text node values, not from AST node boundaries.
function processPreHighlightedAst(ast) {
  let lineNumber = 1;
  const syntaxObj = {};

  const loopAst = (nodes, wrapper) => {
    nodes.forEach((node) => {
      if (node.type === "text") {
        if (!node.value.includes("\n")) {
          const valueLength = node.value.length;

          if (!syntaxObj[lineNumber]) {
            node.startIndex = 0;
            node.endIndex = valueLength - 1;
            syntaxObj[lineNumber] = { lineNumber, nodeList: [{ node, wrapper }], value: node.value, valueLength };
          } else {
            node.startIndex = syntaxObj[lineNumber].valueLength;
            node.endIndex = node.startIndex + valueLength - 1;
            syntaxObj[lineNumber].value += node.value;
            syntaxObj[lineNumber].valueLength += valueLength;
            syntaxObj[lineNumber].nodeList.push({ node, wrapper });
          }

          node.lineNumber = lineNumber;
          return;
        }

        const segments = node.value.split("\n");

        segments.forEach((segment, segmentIndex) => {
          const isLastSegment = segmentIndex === segments.length - 1;
          const segmentValue = isLastSegment ? segment : `${segment}\n`;
          const segmentLineNumber = segmentIndex === 0 ? lineNumber : ++lineNumber;
          const segmentValueLength = segmentValue.length;
          const segmentNode = { endIndex: Infinity, lineNumber: segmentLineNumber, startIndex: Infinity, type: "text", value: segmentValue };

          if (!syntaxObj[segmentLineNumber]) {
            segmentNode.startIndex = 0;
            segmentNode.endIndex = segmentValueLength - 1;
            syntaxObj[segmentLineNumber] = {
              lineNumber: segmentLineNumber,
              nodeList: [{ node: segmentNode, wrapper }],
              value: segmentValue,
              valueLength: segmentValueLength,
            };
          } else {
            segmentNode.startIndex = syntaxObj[segmentLineNumber].valueLength;
            segmentNode.endIndex = segmentNode.startIndex + segmentValueLength - 1;
            syntaxObj[segmentLineNumber].value += segmentValue;
            syntaxObj[segmentLineNumber].valueLength += segmentValueLength;
            syntaxObj[segmentLineNumber].nodeList.push({ node: segmentNode, wrapper });
          }
        });

        node.lineNumber = lineNumber;
        return;
      }

      if (node.children) {
        loopAst(node.children, node);
        node.lineNumber = lineNumber;
      }
    });
  };

  loopAst(ast.children);

  return { syntaxFileLineNumber: lineNumber, syntaxFileObject: syntaxObj };
}

function buildMiniDiffGraph(
  analysis,
  {
    activeStackId = null,
    expandedGroupIds = new Set(),
    fileOrderViewIds = new Set(),
    measuredHeights = null,
  } = {},
) {
  const nodes = [];
  const edges = [];
  const filePages = [];
  const fileSpecs = buildFilePageSpecs(analysis, {
    activeStackId,
    expandedGroupIds,
    fileOrderViewIds,
    measuredHeights,
  });

  for (const spec of fileSpecs) {
    const { file, miniNodes, miniTree, pageHeight, pageId, pageWidth, viewMode, x, y } = spec;
    if (miniNodes.length === 0) {
      continue;
    }

    const layout = spec.layout;

    nodes.push({
      id: pageId,
      data: { file, viewMode },
      draggable: false,
      position: { x, y },
      selectable: false,
      style: { height: pageHeight, width: pageWidth },
      type: "filePage",
    });
    filePages.push({
      edgeCount: miniTree.reviewEdges.length,
      height: pageHeight,
      miniNodeCount: miniNodes.length,
      changeRole: file.changeRole,
      reviewClass: file.reviewClass,
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
        style: { width: miniNodeWidth(item.node) },
        type: item.node.collapsedGroup ? "collapsedGroup" : "miniDiff",
      });
    }

    const miniNodeById = new Map(miniNodes.map((miniNode) => [miniNode.id, miniNode]));
    const validMiniNodeIds = new Set(miniNodeById.keys());
    for (const edge of miniTree.reviewEdges) {
      if (!validMiniNodeIds.has(edge.from) || !validMiniNodeIds.has(edge.to)) {
        continue;
      }

      edges.push({
        id: `${file.id}:${edge.from}->${edge.to}`,
        className: "mini-tree-edge",
        data: {
          comment: edge.comment || "",
          sourceTitle: miniNodeById.get(edge.from)?.title || edge.from,
          targetTitle: miniNodeById.get(edge.to)?.title || edge.to,
        },
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
        type: "reviewExplanation",
        zIndex: 4,
      });
    }

  }

  return {
    defaultViewport: defaultViewportForPages(filePages),
    edges,
    groupIds: fileSpecs.flatMap((spec) => spec.miniTree.groupIds || []),
    nodes,
  };
}

function buildFilePageSpecs(
  analysis,
  {
    activeStackId = null,
    expandedGroupIds = new Set(),
    fileOrderViewIds = new Set(),
    measuredHeights = null,
  } = {},
) {
  const activeFileIds = activeStackId
    ? new Set(
        (analysis?.reviewStack?.stacks || []).find((stack) => stack.id === activeStackId)?.fileIds || [],
      )
    : null;
  const fileLayouts = (analysis?.files || [])
    .filter((file) => miniTreeNodes(file).length > 0)
    .filter((file) => !activeFileIds || activeFileIds.has(file.id))
    .map((file) => buildFileLayout(file, {
      expandedGroupIds,
      getMiniNodeHeight: measuredHeights
        ? (node) => measuredHeights.get(miniNodeId(file, node.id)) ?? miniNodeHeight(node)
        : miniNodeHeight,
      viewMode: fileOrderViewIds.has(file.id) ? "file" : "tree",
    }));

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
  const fileLayouts = files.map((file) => buildFileLayout(file));
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

function buildFileLayout(
  file,
  { expandedGroupIds = new Set(), getMiniNodeHeight = miniNodeHeight, viewMode = "tree" } = {},
) {
  const miniTree = viewMode === "file"
    ? buildFileOrderMiniTree(file)
    : foldMiniTree(file, { expandedGroupIds });
  const miniNodes = miniTree.nodes;
  const layout = layoutMiniNodes(miniNodes, miniTree.reviewEdges, getMiniNodeHeight);

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
    viewMode,
  };
}

function buildFileOrderMiniTree(file) {
  return {
    groupIds: [],
    nodes: [{
      id: "file-order-view",
      title: "File-order diff",
      reviewClass: file.reviewClass || "important",
      changeRole: file.changeRole || "runtime",
      comment: "This view keeps every changed hunk together in source order for reviewers who prefer top-to-bottom file context. It intentionally presents file order rather than the causal review hierarchy.",
      changedLineIds: file.codeRefs?.changedLineIds || [],
      codeChunks: file.fileOrderCodeChunks || [],
      fileOrderView: true,
    }],
    relations: [],
    reviewEdges: [],
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
  const reviewOrderById = new Map();

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
    if (Number.isInteger(edge.order)) {
      reviewOrderById.set(edge.to, edge.order);
    }
  }

  for (const children of childrenById.values()) {
    children.sort((leftId, rightId) => {
      return (
        (reviewOrderById.get(leftId) ?? itemById.get(leftId).order)
        - (reviewOrderById.get(rightId) ?? itemById.get(rightId).order)
      );
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
    const reviewClassDifference = (
      fileReviewClassPriority(page.reviewClass)
      - fileReviewClassPriority(best.reviewClass)
    );
    if (reviewClassDifference !== 0) {
      return reviewClassDifference < 0 ? page : best;
    }
    const changeRoleDifference = (
      fileChangeRolePriority(page.changeRole)
      - fileChangeRolePriority(best.changeRole)
    );
    if (changeRoleDifference !== 0) {
      return changeRoleDifference < 0 ? page : best;
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

function fileReviewClassPriority(reviewClass) {
  return FILE_REVIEW_CLASS_PRIORITY.get(reviewClass) ?? FILE_REVIEW_CLASS_PRIORITY.size;
}

function fileChangeRolePriority(changeRole) {
  return FILE_CHANGE_ROLE_PRIORITY.get(changeRole) ?? FILE_CHANGE_ROLE_PRIORITY.size;
}

function layoutMiniNodes(miniNodes, miniEdges, getMiniNodeHeight = miniNodeHeight) {
  const items = miniNodes.map((node, order) => ({
    height: getMiniNodeHeight(node),
    node,
    order,
    width: miniNodeWidth(node),
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
  if (miniNode.collapsedGroup) {
    return MINI_TREE_GROUP_NODE_HEIGHT;
  }

  const lineCount = (miniNode.codeChunks || []).reduce((total, chunk) => total + (chunk.lines || []).length, 0);
  return Math.max(120, MINI_NODE_HEADER_HEIGHT + lineCount * 18 + 2);
}

function miniNodeWidth(miniNode) {
  return miniNode.collapsedGroup ? MINI_TREE_GROUP_NODE_WIDTH : MINI_NODE_WIDTH;
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
  return normalizeMiniTree(file).nodes;
}

function usePersistentStringSet(storageKey) {
  const [values, setValues] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
      return new Set(Array.isArray(stored) ? stored : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...values]));
    } catch {
      // Persistence is optional when the review runs in a restricted browser.
    }
  }, [storageKey, values]);

  return [values, setValues];
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
