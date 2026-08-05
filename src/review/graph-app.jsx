import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileCode2,
  FileDiff,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Layers3,
  Network,
  UserRound,
} from "lucide-react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  MarkerType,
  MiniMap,
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
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.jsx";
import { cn } from "../lib/utils.js";
import { foldMiniTree, normalizeMiniTree } from "./mini-tree-model.js";

const FILE_PAGE_GAP_X = 160;
const FILE_PAGE_PADDING = 32;
const FILE_PAGE_PADDING_TOP = 72;
const FILE_PAGE_MIN_HEIGHT = 180;
const FILE_PAGE_STACK_GAP_Y = 56;
const MINI_CODE_CHARACTER_COLUMNS = 120;
const MINI_CODE_CHARACTER_WIDTH = 7;
const MINI_DIFF_GUTTER_WIDTH = 102;
const MINI_DIFF_HORIZONTAL_PADDING = 18;
const MINI_NODE_WIDTH = (
  MINI_CODE_CHARACTER_COLUMNS * MINI_CODE_CHARACTER_WIDTH
  + MINI_DIFF_GUTTER_WIDTH
  + MINI_DIFF_HORIZONTAL_PADDING
);
const MINI_NODE_HEADER_HEIGHT = 42;
const MINI_TREE_GROUP_NODE_HEIGHT = 118;
const MINI_TREE_GROUP_NODE_WIDTH = 520;
const MINI_TREE_LAYER_GAP_Y = 110;
const MINI_TREE_SIBLING_GAP_X = 72;
const MIN_GRAPH_ZOOM = 0.18;
const REVIEW_CAMERA_DURATION = 220;
const REVIEW_CAMERA_PADDING_X = 80;
const REVIEW_NODE_MAX_ZOOM = 1.25;
const FILE_FLOW_LAYER_GAP_Y = FILE_PAGE_STACK_GAP_Y * 3;
const FILE_FLOW_SIBLING_GAP_X = FILE_PAGE_GAP_X;
const VIEWPORT_PADDING_Y = 176;
const FALLBACK_GRAPH_VIEWPORT = { x: 72, y: 52, zoom: 0.86 };
const FILE_FLOW_SOURCE_HANDLE = "file-flow-source";
const FILE_FLOW_TARGET_HANDLE = "file-flow-target";
const INITIAL_COLOR_MODE = document.documentElement.classList.contains("dark") ? "dark" : "light";
const REVIEW_STEP_BUTTON_CLASS = "review-step-button absolute z-[12] -translate-y-1/2 border-[color-mix(in_oklab,var(--primary)_38%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_12%,var(--background))] text-primary shadow-xs enabled:hover:border-[color-mix(in_oklab,var(--primary)_54%,var(--border))] enabled:hover:bg-[color-mix(in_oklab,var(--primary)_20%,var(--background))] enabled:hover:text-primary motion-reduce:transition-none";
const REVIEW_NAVIGATION_CONTROL_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable=true]",
  "[role=button]",
  "[role=combobox]",
  "[role=dialog]",
  "[role=listbox]",
  "[role=menu]",
  "[role=menuitem]",
  "[role=option]",
  "[role=slider]",
  "[role=tab]",
  "[role=textbox]",
].join(", ");
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
  const reactFlowData = useMemo(readReactFlowData, []);
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
    <div className="review-shell fixed inset-0 grid h-dvh w-screen min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden bg-background">
      <ReviewHeader review={review} />
      <main className="review-main grid min-h-0 overflow-hidden">
        {hasGraph ? (
          <section className="graph-panel size-full min-h-0 overflow-hidden rounded-none border-0 bg-card shadow-none" aria-label="PR review tree">
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
          <section className="empty-panel grid size-full min-h-0 place-items-center overflow-hidden rounded-none border-0 bg-card text-sm text-muted-foreground shadow-none">
            Review tree is not available for this run.
          </section>
        )}
      </main>
    </div>
  );
}

function ReviewHeader({ review }) {
  return (
    <header className="review-header sticky top-0 z-20 border-b border-border bg-[color-mix(in_oklab,var(--card)_92%,var(--background))] px-5 py-3 shadow-xs backdrop-blur-[20px] max-[980px]:px-3 max-[980px]:py-2.5">
      <div className="review-header-main grid grid-cols-[minmax(0,1fr)_auto] items-center justify-between gap-3.5 max-[980px]:grid-cols-1 max-[980px]:gap-2">
        <div className="review-title-row flex min-w-0 flex-auto items-center gap-2.5 max-[980px]:flex-wrap max-[980px]:gap-2">
          <div className="review-eyebrow flex flex-none items-center gap-[7px] text-xs font-bold tracking-[0.08em] text-primary uppercase">
            <span className="review-mark inline-flex size-[30px] items-center justify-center rounded-md border border-[color-mix(in_oklab,var(--primary)_32%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_10%,var(--card))] text-primary shadow-xs">
              <GitPullRequest aria-hidden="true" size={16} />
            </span>
            <span>{`PR #${review.number || "unknown"}`}</span>
            <Badge className="state-badge" variant="secondary">
              {review.state || "unknown"}
            </Badge>
          </div>
          <h1 className="review-title m-0 min-w-[120px] flex-auto truncate font-display text-xl leading-[1.2] font-bold tracking-normal text-foreground max-[980px]:order-2 max-[980px]:basis-full max-[980px]:text-lg [&_a]:no-underline [&_a:hover]:text-primary">
            <a href={review.url}>{review.title || "Untitled pull request"}</a>
          </h1>
        </div>
        <div className="review-meta flex min-w-0 max-w-[min(44vw,520px)] flex-[0_1_auto] flex-wrap justify-end gap-2 max-[980px]:max-w-full max-[980px]:justify-start">
          <Badge
            className="meta-chip branch-chip min-w-0 max-w-[min(27vw,255px)] font-mono"
            title="Base and head branches"
            variant="outline"
          >
            <GitBranch aria-hidden="true" size={14} />
            <span className="branch-name is-base min-w-0 max-w-[82px] flex-[0_1_auto] truncate">{review.baseRefName || "base"}</span>
            <span aria-hidden="true" className="branch-arrow flex-none font-extrabold text-muted-foreground">
              &lt;-
            </span>
            <span className="branch-name is-head min-w-0 max-w-[138px] flex-1 truncate">{review.headRefName || "head"}</span>
          </Badge>
          <Badge
            className="meta-chip author-chip min-w-0 max-w-[150px]"
            title="Author"
            variant="outline"
          >
            <UserRound aria-hidden="true" size={14} />
            <span className="author-name min-w-0 truncate">{review.authorLogin || "unknown"}</span>
          </Badge>
          <Badge className="change-pill is-add min-w-0 font-mono" variant="outline">
            +{review.additions ?? 0}
          </Badge>
          <Badge className="change-pill is-del min-w-0 font-mono" variant="outline">
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
  const canvasRef = useRef(null);
  const currentFilePageIdRef = useRef(null);
  const pendingSnapIdRef = useRef(null);
  const snapRetryFrameRef = useRef(null);
  const defaultViewport = graph.defaultViewport || FALLBACK_GRAPH_VIEWPORT;
  const reviewStops = useMemo(() => {
    return graph.nodes.filter(({ type }) => type === "miniDiff");
  }, [graph.nodes]);
  const reviewStopIds = useMemo(() => new Set(reviewStops.map(({ id }) => id)), [reviewStops]);
  const reviewStopTargets = useMemo(() => {
    const targets = new Map();
    for (const stop of reviewStops) {
      targets.set(stop.id, stop.id);
      if (stop.parentId && !targets.has(stop.parentId)) {
        targets.set(stop.parentId, stop.id);
      }
    }
    return targets;
  }, [reviewStops]);
  const [currentStopId, setCurrentStopId] = useState(() => reviewStops[0]?.id ?? null);
  const navigation = useMemo(() => {
    const currentIndex = reviewStops.findIndex(({ id }) => id === currentStopId);
    const current = reviewStops[currentIndex] ?? null;
    const fileRoots = reviewStops.filter((stop, index) => (
      stop.parentId !== reviewStops[index - 1]?.parentId
    ));
    const currentFileIndex = fileRoots.findIndex(({ parentId }) => parentId === current?.parentId);
    return {
      current,
      currentIndex,
      next: reviewStops[currentIndex + 1] ?? null,
      nextFile: fileRoots[currentFileIndex + 1] ?? null,
      previous: reviewStops[currentIndex - 1] ?? null,
      previousFile: fileRoots[currentFileIndex - 1] ?? null,
    };
  }, [currentStopId, reviewStops]);
  const snapToStop = useCallback((nodeId) => {
    const stopId = reviewStopTargets.get(nodeId);
    if (!stopId) {
      return false;
    }

    setCurrentStopId(stopId);
    const node = reactFlow.getInternalNode(stopId);
    currentFilePageIdRef.current = node?.parentId ?? currentFilePageIdRef.current;
    const canvas = canvasRef.current;
    const nodeWidth = node?.measured?.width;
    if (!nodeWidth || !node.measured.height || !canvas) {
      pendingSnapIdRef.current = stopId;
      if (snapRetryFrameRef.current === null) {
        snapRetryFrameRef.current = window.requestAnimationFrame(() => {
          snapRetryFrameRef.current = null;
          snapToStop(pendingSnapIdRef.current);
        });
      }
      return false;
    }

    pendingSnapIdRef.current = null;
    reactFlow.setViewport(reviewViewportForNode(node, nodeWidth, canvas.getBoundingClientRect()), {
      duration: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? 0
        : REVIEW_CAMERA_DURATION,
    });
    return true;
  }, [reactFlow, reviewStopTargets]);
  useEffect(() => {
    return () => {
      if (snapRetryFrameRef.current !== null) {
        window.cancelAnimationFrame(snapRetryFrameRef.current);
      }
    };
  }, []);
  useEffect(() => {
    snapToStop(reviewStops[0]?.id);
    // Start each selected stack at its first mini-tree root. Do not depend on
    // graph rebuilds here: measurement updates must not fight manual panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStackId]);
  useEffect(() => {
    if (!currentStopId || !reviewStopIds.has(currentStopId)) {
      const fallback = reviewStops.find(({ parentId }) => parentId === currentFilePageIdRef.current);
      snapToStop(fallback?.id ?? reviewStops[0]?.id);
    }
  }, [currentStopId, reviewStopIds, reviewStops, snapToStop]);
  useEffect(() => {
    if (pendingSnapIdRef.current) {
      snapToStop(pendingSnapIdRef.current);
    }
  }, [graph.nodes, snapToStop]);
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
  const handleToggleCollapsedGroup = useCallback((groupId) => {
    onToggleCollapsedGroup(groupId);
  }, [onToggleCollapsedGroup]);
  const handleNodeClick = useCallback((event, node) => {
    const target = event.target;
    if (
      !reviewStopTargets.has(node.id)
      || window.getSelection()?.isCollapsed === false
      || (target instanceof Element && target.closest(REVIEW_NAVIGATION_CONTROL_SELECTOR))
    ) {
      return;
    }

    snapToStop(node.id);
  }, [reviewStopTargets, snapToStop]);
  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target;
      if (
        event.defaultPrevented
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || window.getSelection()?.isCollapsed === false
        || (target instanceof Element && target.closest(REVIEW_NAVIGATION_CONTROL_SELECTOR))
      ) {
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const destination = event.key === "ArrowLeft"
          ? (event.shiftKey ? navigation.previousFile : navigation.previous)
          : (event.shiftKey ? navigation.nextFile : navigation.next);
        snapToStop(destination?.id);
        return;
      }

    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigation, snapToStop]);
  const interactiveNodes = useMemo(() => {
    return graph.nodes.map((node) => {
      if (node.type === "collapsedGroup") {
        return {
          ...node,
          data: {
            ...node.data,
            onToggleCollapsedGroup: handleToggleCollapsedGroup,
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
  }, [graph.nodes, handleToggleCollapsedGroup, onFileViewModeChange]);
  useEffect(() => {
    const canvas = canvasRef.current;
    let activeNode;
    let frame;
    const applyCurrentStop = () => {
      activeNode = [...(canvas?.querySelectorAll(".react-flow__node") || [])]
        .find((node) => node.dataset.id === currentStopId);
      canvas?.querySelector('[aria-current="step"]')?.removeAttribute("aria-current");
      activeNode?.setAttribute("aria-current", "step");
      if (!activeNode && currentStopId) {
        frame = window.requestAnimationFrame(applyCurrentStop);
      }
    };
    applyCurrentStop();

    return () => {
      activeNode?.removeAttribute("aria-current");
      window.cancelAnimationFrame(frame);
    };
  }, [currentStopId, graph.nodes]);
  const currentStopTitle = reviewStopTitle(navigation.current);
  return (
    <div className="flow-reader relative grid size-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-card" data-flow-reader>
      <div className="flow-canvas relative col-start-1 row-start-1 size-full min-h-0 min-w-0" ref={canvasRef}>
        <ReactFlow
          colorMode={INITIAL_COLOR_MODE}
          defaultViewport={defaultViewport}
          edges={graph.edges}
          edgeTypes={edgeTypes}
          maxZoom={1.7}
          minZoom={MIN_GRAPH_ZOOM}
          nodesConnectable={false}
          nodesDraggable={false}
          nodes={interactiveNodes}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
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
          <MiniMap
            ariaLabel="Review map"
            className="review-minimap"
            nodeClassName={reviewMapNodeClassName}
            nodeColor={reviewMapNodeColor}
            nodeComponent={ReviewMapNode}
            nodeStrokeColor={(node) => node.id === currentStopId ? "var(--primary)" : "transparent"}
            nodeStrokeWidth={4}
            onNodeClick={(event, node) => {
              event.stopPropagation();
              snapToStop(node.id);
            }}
            pannable
            position="top-right"
            zoomable={false}
          />
        </ReactFlow>
        <StackSelect activeStackId={activeStackId} onActiveStackChange={onActiveStackChange} stacks={stacks} />
        <Button
          aria-label={navigation.previousFile
            ? `Previous file: ${reviewStopTitle(navigation.previousFile)}`
            : "No previous file"}
          className={`${REVIEW_STEP_BUTTON_CLASS} is-previous-file left-4 top-[calc(50%_+_26px)]`}
          disabled={!navigation.previousFile}
          onClick={() => snapToStop(navigation.previousFile?.id)}
          size="icon-lg"
          title={navigation.previousFile ? `Previous file: ${reviewStopTitle(navigation.previousFile)}` : "First file"}
          type="button"
          variant="outline"
        >
          <ChevronsLeft aria-hidden="true" />
        </Button>
        <Button
          aria-label={navigation.previous
            ? `Previous review stop: ${reviewStopTitle(navigation.previous)}`
            : "No previous review stop"}
          className={`${REVIEW_STEP_BUTTON_CLASS} is-previous left-4 top-[calc(50%_-_26px)]`}
          disabled={!navigation.previous}
          onClick={() => snapToStop(navigation.previous?.id)}
          size="icon-lg"
          title={navigation.previous ? `Previous: ${reviewStopTitle(navigation.previous)}` : "First stop"}
          type="button"
          variant="outline"
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Badge
          aria-atomic="true"
          aria-live="polite"
          className="review-progress absolute top-5 left-1/2 z-[12] min-w-16 -translate-x-1/2 font-mono motion-reduce:transition-none"
          role="status"
          variant="outline"
        >
          <span aria-hidden="true">{`${Math.max(0, navigation.currentIndex + 1)} / ${reviewStops.length}`}</span>
          <span className="sr-only">
            {navigation.current
              ? `Moved to ${currentStopTitle}, stop ${navigation.currentIndex + 1} of ${reviewStops.length}`
              : "No visible review stops"}
          </span>
        </Badge>
        <Button
          aria-label={navigation.next
            ? `Next review stop: ${reviewStopTitle(navigation.next)}`
            : "No next review stop"}
          className={`${REVIEW_STEP_BUTTON_CLASS} is-next right-4 top-[calc(50%_-_26px)]`}
          disabled={!navigation.next}
          onClick={() => snapToStop(navigation.next?.id)}
          size="icon-lg"
          title={navigation.next ? `Next: ${reviewStopTitle(navigation.next)}` : "Last stop"}
          type="button"
          variant="outline"
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <Button
          aria-label={navigation.nextFile
            ? `Next file: ${reviewStopTitle(navigation.nextFile)}`
            : "No next file"}
          className={`${REVIEW_STEP_BUTTON_CLASS} is-next-file right-4 top-[calc(50%_+_26px)]`}
          disabled={!navigation.nextFile}
          onClick={() => snapToStop(navigation.nextFile?.id)}
          size="icon-lg"
          title={navigation.nextFile ? `Next file: ${reviewStopTitle(navigation.nextFile)}` : "Last file"}
          type="button"
          variant="outline"
        >
          <ChevronsRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function reviewViewportForNode(node, nodeWidth, canvasBounds) {
  const { x, y } = node.internals.positionAbsolute;
  const zoom = Math.max(
    MIN_GRAPH_ZOOM,
    Math.min(REVIEW_NODE_MAX_ZOOM, (canvasBounds.width - REVIEW_CAMERA_PADDING_X * 2) / nodeWidth),
  );

  return {
    x: Math.round(canvasBounds.width / 2 - (x + nodeWidth / 2) * zoom),
    y: Math.round(VIEWPORT_PADDING_Y - y * zoom),
    zoom,
  };
}

function reviewStopTitle(stop) {
  return stop?.data?.miniNode?.title || stop?.data?.file?.path || "review stop";
}

function reviewMapNodeColor(node) {
  if (node.type === "filePage") {
    return "color-mix(in oklab, var(--card) 90%, var(--mini-tree-color))";
  }

  return {
    important: "var(--coral)",
    mechanical: "var(--muted-foreground)",
    supporting: "var(--ochre)",
  }[node.data?.miniNode?.reviewClass] || "var(--mini-tree-color)";
}

function reviewMapNodeClassName(node) {
  return `is-${node.type} is-${node.data?.miniNode?.reviewClass || "page"}`;
}

function ReviewMapNode({
  borderRadius,
  className,
  color,
  height,
  id,
  onClick,
  shapeRendering,
  strokeColor,
  strokeWidth,
  width,
  x,
  y,
}) {
  const isFilePage = className.includes("is-filePage");
  const isGroup = className.includes("is-collapsedGroup");
  const headerHeight = isFilePage ? Math.max(36, height * 0.05) : Math.max(24, height * 0.18);
  const lineWidth = Math.max(10, Math.min(width, height) * 0.035);

  return (
    <g
      className={`react-flow__minimap-node ${className}`}
      onClick={onClick ? (event) => onClick(event, id) : undefined}
    >
      <rect
        fill={isFilePage ? color : "var(--card)"}
        height={height}
        rx={borderRadius}
        ry={borderRadius}
        shapeRendering={shapeRendering}
        width={width}
        x={x}
        y={y}
      />
      <rect
        fill={color}
        height={Math.min(height, headerHeight)}
        opacity={isFilePage ? 0.45 : 0.8}
        rx={borderRadius}
        ry={borderRadius}
        width={width}
        x={x}
        y={y}
      />
      {!isFilePage && !isGroup ? [0.48, 0.64, 0.8].map((offset, index) => (
        <line
          key={offset}
          opacity={0.55}
          stroke={color}
          strokeWidth={lineWidth}
          x1={x + width * 0.1}
          x2={x + width * (0.88 - index * 0.12)}
          y1={y + height * offset}
          y2={y + height * offset}
        />
      )) : null}
      <rect
        fill="none"
        height={height}
        pointerEvents="none"
        rx={borderRadius}
        ry={borderRadius}
        shapeRendering={shapeRendering}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        width={width}
        x={x}
        y={y}
      />
    </g>
  );
}

function StackSelect({ activeStackId, onActiveStackChange, stacks }) {
  if (stacks.length < 2) {
    return null;
  }

  return (
    <Select onValueChange={onActiveStackChange} value={activeStackId ?? undefined}>
      <SelectTrigger
        aria-label="Review stack"
        className="stack-select-trigger absolute top-4 left-[18px] z-[11] w-[280px] max-w-[min(320px,calc(50%_-_70px))] border-[color-mix(in_oklab,var(--primary)_36%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_9%,var(--card))] text-foreground shadow-xs hover:bg-[color-mix(in_oklab,var(--primary)_15%,var(--card))] [&_[data-slot=select-value]]:capitalize"
      >
        <span className="stack-select-icon grid size-[26px] shrink-0 place-items-center rounded-sm border border-[color-mix(in_oklab,var(--primary)_34%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_8%,var(--card))] text-primary [&_svg]:size-[15px]">
          <Layers3 aria-hidden="true" className="text-primary" />
        </span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="start"
        className="stack-select-content w-[var(--radix-select-trigger-width)] max-w-[calc(100vw_-_32px)] border-[color-mix(in_oklab,var(--primary)_28%,var(--border))]"
        position="popper"
      >
        {stacks.map((stack) => (
          <SelectItem
            className="stack-select-item min-h-9 whitespace-normal capitalize leading-[1.3] data-[state=checked]:bg-[color-mix(in_oklab,var(--primary)_9%,var(--accent))] data-[state=checked]:font-bold data-[state=checked]:text-foreground data-[state=checked]:shadow-[inset_3px_0_0_var(--primary)]"
            key={stack.id}
            value={stack.id}
          >
            {stack.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FilePageNode({ data }) {
  const filePath = data.file?.path || "Unknown file";
  const viewMode = data.viewMode === "file" ? "file" : "tree";
  const fileComment = data.file?.comment || "";

  return (
    <section
      aria-label={`Mini-tree for ${filePath}`}
      className="file-page-node relative size-full rounded-lg border border-[color-mix(in_oklab,var(--primary)_34%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_5%,var(--card))]"
    >
      <Handle className="node-handle" id={FILE_FLOW_TARGET_HANDLE} position={Position.Top} type="target" />
      <Handle className="node-handle" id={FILE_FLOW_SOURCE_HANDLE} position={Position.Bottom} type="source" />
      <div className="file-page-header absolute top-[11px] right-3.5 left-3.5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5">
        <ExplanationHoverCard
          comment={fileComment}
          contextLabel="File: What / Why"
          side="bottom"
          title={filePath}
        >
          <Badge
            className="file-page-label max-w-full min-w-0 justify-self-start gap-2 overflow-hidden px-2.5 py-2 font-mono text-[13px] leading-none font-bold tracking-normal whitespace-nowrap text-primary select-none [&>span]:min-w-0 [&>span]:truncate data-[has-explanation=true]:pointer-events-auto data-[has-explanation=true]:cursor-help"
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
          className="file-page-view-tabs nodrag nopan pointer-events-auto gap-0 select-none"
          onValueChange={(nextMode) => data.onFileViewModeChange?.(data.file.id, nextMode)}
          value={viewMode}
        >
          <TabsList aria-label={`${filePath} view`} className="file-page-view-tabs-list w-[136px]">
            <TabsTrigger className="file-page-view-tab text-[11px]" value="tree">
              <Network aria-hidden="true" size={14} />
              Tree
            </TabsTrigger>
            <TabsTrigger className="file-page-view-tab text-[11px]" value="file">
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
  const reviewClass = data.miniNode.reviewClass;
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
        <article
          className={cn(
            "collapsed-review-group nodrag nopan size-full overflow-hidden rounded-md border border-border bg-card shadow-sm",
            reviewClass === "important" && "border-[color-mix(in_oklab,var(--coral)_46%,var(--border))] bg-[color-mix(in_oklab,var(--coral)_6%,var(--card))]",
            reviewClass === "supporting" && "border-[color-mix(in_oklab,var(--ochre)_46%,var(--border))] bg-[color-mix(in_oklab,var(--ochre)_6%,var(--card))]",
            reviewClass === "mechanical" && "border-[color-mix(in_oklab,var(--muted-foreground)_34%,var(--border))] bg-[color-mix(in_oklab,var(--muted)_46%,var(--card))]",
          )}
        >
          <Handle className="node-handle" position={Position.Top} type="target" />
          <CollapsibleTrigger asChild>
            <Button
              aria-label={`${action} ${data.miniNode.title}`}
              className="collapsed-review-group-button grid size-full cursor-pointer grid-cols-[44px_minmax(0,1fr)_28px] items-center gap-3 border-0 bg-transparent px-4 py-3.5 text-left font-[inherit] tracking-normal text-foreground"
              title={`${action}: ${rootPreview}`}
              type="button"
              variant="ghost"
            >
              <span
                className={cn(
                  "collapsed-review-group-icon grid size-[42px] place-items-center rounded-sm border border-[color-mix(in_oklab,currentColor_18%,var(--border))] bg-muted text-coral-strong",
                  reviewClass === "supporting" && "text-ochre-strong",
                  reviewClass === "mechanical" && "text-muted-foreground",
                )}
              >
                <FolderTree aria-hidden="true" size={20} />
              </span>
              <span className="collapsed-review-group-copy grid min-w-0 gap-[5px]">
                <span className="collapsed-review-group-title truncate text-sm leading-[1.1] font-extrabold">{data.miniNode.title}</span>
                <span className="collapsed-review-group-summary truncate font-mono text-[11px] leading-[1.15] font-semibold tracking-normal text-muted-foreground">
                  {`${group.subtreeCount} ${group.subtreeCount === 1 ? "subtree" : "subtrees"} · ${group.nodeCount} nodes · ${group.lineCount} changed lines`}
                </span>
                <span className="collapsed-review-group-preview truncate text-[11px] leading-[1.15] tracking-normal text-muted-foreground">{rootPreview}</span>
              </span>
              <span className="collapsed-review-group-toggle grid size-7 place-items-center rounded-sm text-muted-foreground">
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
  const showHandles = !data.miniNode.fileOrderView;

  const nodeComment = data.miniNode.comment || "";

  return (
    <article
      aria-label={`Code diff mini node for ${filePath}: ${data.miniNode.title}. ${plainTextComment(nodeComment)}`}
      className={cn(
        "mini-diff-node nodrag nopan w-full max-w-full cursor-text overflow-hidden rounded-md border border-border bg-card shadow-sm select-text",
        reviewClass === "important" && "border-[color-mix(in_oklab,var(--coral)_46%,var(--border))]",
        reviewClass === "supporting" && "border-[color-mix(in_oklab,var(--ochre)_46%,var(--border))]",
        reviewClass === "mechanical" && "border-[color-mix(in_oklab,var(--muted-foreground)_34%,var(--border))]",
      )}
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
          className={cn(
            "mini-diff-header flex h-[42px] w-full min-w-0 items-center overflow-hidden border-b border-border bg-muted px-3 text-xs leading-none text-card-foreground outline-none data-[slot=hover-card-trigger]:cursor-help focus-visible:shadow-[inset_0_0_0_3px_color-mix(in_oklab,var(--ring)_30%,transparent)]",
            reviewClass === "important" && "bg-[color-mix(in_oklab,var(--coral)_9%,var(--muted))]",
            reviewClass === "supporting" && "bg-[color-mix(in_oklab,var(--ochre)_9%,var(--muted))]",
          )}
          tabIndex={nodeComment ? 0 : undefined}
        >
          <span className="mini-diff-title min-w-0 truncate text-xs font-bold tracking-normal" title={data.miniNode.title}>
            {data.miniNode.title}
          </span>
        </header>
      </ExplanationHoverCard>
      <div className="mini-diff-scroll max-w-full overflow-x-auto overflow-y-hidden overscroll-contain">
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
        className="explanation-hover-card nodrag nopan nowheel max-h-[min(640px,calc(100vh_-_32px))] w-[min(520px,calc(100vw_-_32px))] overflow-x-hidden overflow-y-auto border-[color-mix(in_oklab,var(--primary)_34%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_5%,var(--popover))] shadow-sm"
        side={side}
        sideOffset={10}
      >
        <div className="explanation-hover-label text-[11px] leading-[1.2] font-extrabold tracking-normal text-primary uppercase">{contextLabel}</div>
        <div className="explanation-hover-title mt-1.5 text-sm leading-[1.35] font-extrabold tracking-normal text-foreground [overflow-wrap:anywhere]">{title}</div>
        <div className="explanation-hover-comment mt-2.5 text-[13px] leading-[1.55] text-muted-foreground [overflow-wrap:anywhere]">
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

  return (
    <div className="mini-diff-gap-divider border-y border-border bg-[color-mix(in_oklab,var(--muted)_45%,var(--card))] px-2.5 py-[3px] text-[10px] font-semibold tracking-[0.02em] text-muted-foreground">
      ⋯ {gap} unchanged lines
    </div>
  );
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
  const { data, realNewLineNumbers, realOldLineNumbers, registerHighlighter } = useMemo(
    () => buildChunkDiffData(chunk),
    [chunk],
  );
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    const applyRealLineNumbers = () => {
      container.querySelectorAll("[data-line-old-num]").forEach((el) => {
        const real = realOldLineNumbers[Number(el.getAttribute("data-line-old-num")) - 1];

        // Idempotency check matters here: this mutates text inside the subtree the
        // MutationObserver below watches, and a no-op guard is what keeps that from
        // re-triggering itself forever.
        if (real != null && el.textContent !== String(real)) {
          el.textContent = String(real);
        }
      });

      container.querySelectorAll("[data-line-new-num]").forEach((el) => {
        const real = realNewLineNumbers[Number(el.getAttribute("data-line-new-num")) - 1];

        if (real != null && el.textContent !== String(real)) {
          el.textContent = String(real);
        }
      });
    };

    // DiffView defers rendering its rows until after mount (avoids an SSR hydration
    // mismatch), so the gutter spans this patches don't exist on the first paint.
    applyRealLineNumbers();
    const observer = new MutationObserver(applyRealLineNumbers);
    observer.observe(container, { characterData: true, childList: true, subtree: true });

    return () => observer.disconnect();
  }, [realNewLineNumbers, realOldLineNumbers]);

  return (
    <div ref={containerRef}>
      <DiffView
        className="mini-diff-code"
        data={data}
        diffViewFontSize={11}
        diffViewHighlight
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme={INITIAL_COLOR_MODE}
        diffViewWrap={false}
        registerHighlighter={registerHighlighter}
      />
    </div>
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
    // The library numbers its gutter from the synthetic 1-based hunk above; these are the
    // real PR line numbers for the same positions, used to patch the gutter after render.
    realOldLineNumbers: oldLines.map((line) => line.oldLine),
    realNewLineNumbers: newLines.map((line) => line.newLine),
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
          properties: { className: ["shiki-token"], style: token.style },
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
  const activeStack = activeStackId
    ? (analysis?.reviewStack?.stacks || []).find((stack) => stack.id === activeStackId)
    : null;
  const fileFlowEdges = activeStack ? analysis?.fileFlows?.[activeStack.id]?.edges || [] : [];
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
      initialHeight: pageHeight,
      initialWidth: pageWidth,
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
        initialHeight: item.height,
        initialWidth: miniNodeWidth(item.node),
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
          height: 12,
          type: MarkerType.ArrowClosed,
          width: 12,
        },
        source: miniNodeId(file, edge.from),
        style: {
          stroke: "var(--mini-tree-color)",
          strokeLinecap: "round",
          strokeOpacity: 0.8,
          strokeWidth: 2.5,
        },
        target: miniNodeId(file, edge.to),
        type: "reviewExplanation",
        zIndex: 4,
      });
    }

  }

  const fileSpecById = new Map(fileSpecs.map((spec) => [spec.file.id, spec]));
  for (const edge of fileFlowEdges) {
    const sourceSpec = fileSpecById.get(edge.from);
    const targetSpec = fileSpecById.get(edge.to);
    if (!sourceSpec || !targetSpec) {
      continue;
    }

    edges.push({
      id: `file-flow:${edge.from}->${edge.to}`,
      className: "file-flow-edge",
      data: {
        comment: edge.comment || "",
        sourceTitle: sourceSpec.file.path || edge.from,
        targetTitle: targetSpec.file.path || edge.to,
      },
      markerEnd: {
        color: "var(--middle-tree-color)",
        height: 16,
        type: MarkerType.ArrowClosed,
        width: 16,
      },
      source: sourceSpec.pageId,
      sourceHandle: FILE_FLOW_SOURCE_HANDLE,
      style: {
        stroke: "var(--middle-tree-color)",
        strokeLinecap: "round",
        strokeOpacity: 0.75,
        strokeWidth: 5,
      },
      target: targetSpec.pageId,
      targetHandle: FILE_FLOW_TARGET_HANDLE,
      type: "reviewExplanation",
      zIndex: 3,
    });
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
  const activeStack = activeStackId
    ? (analysis?.reviewStack?.stacks || []).find((stack) => stack.id === activeStackId)
    : null;
  const activeFileIds = activeStack ? new Set(activeStack.fileIds || []) : null;
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

  const fileFlow = activeStack ? analysis?.fileFlows?.[activeStack.id] : null;
  return fileFlow
    ? layoutFilePagesByFlow(fileLayouts, fileFlow.edges)
    : layoutIndependentFilePages(fileLayouts);
}

function layoutFilePagesByFlow(fileLayouts, edges) {
  const items = fileLayouts.map((fileLayout, order) => ({
    fileLayout,
    height: fileLayout.pageHeight,
    order,
    width: fileLayout.pageWidth,
  }));
  const layout = layoutGroupsTopToBottom({
    edges,
    getId: (item) => item.fileLayout.file.id,
    items,
    layerGap: FILE_FLOW_LAYER_GAP_Y,
    siblingGap: FILE_FLOW_SIBLING_GAP_X,
  });

  return layout.placements.map(({ item, x, y }) => ({ ...item.fileLayout, x, y }));
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
      height: item.height,
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

function readReactFlowData() {
  return readJsonScript("pr-analysis-data", null);
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
