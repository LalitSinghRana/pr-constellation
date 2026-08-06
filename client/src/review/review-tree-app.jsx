import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodes,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
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
  UserRound,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
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
import { buildChunkDiffData } from "./diff-view-model.js";
import { foldSectionTree, normalizeSectionTree } from "./section-tree-model.js";

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
const REVIEW_CAMERA_DURATION = 220;
const REVIEW_CAMERA_PADDING_X = 80;
const REVIEW_STEP_MAX_ZOOM = 1.25;
const FILE_TREE_LAYER_GAP_Y = FILE_NODE_STACK_GAP_Y * 3;
const FILE_TREE_SIBLING_GAP_X = FILE_NODE_GAP_X;
const VIEWPORT_PADDING_Y = 176;
const FALLBACK_TREE_VIEWPORT = { x: 72, y: 52, zoom: 0.86 };
const FILE_TREE_SOURCE_HANDLE = "file-tree-source";
const FILE_TREE_TARGET_HANDLE = "file-tree-target";
const INITIAL_COLOR_MODE = document.documentElement.classList.contains("dark") ? "dark" : "light";
const REVIEW_STEP_BUTTON_CLASS =
  "review-step-button absolute z-[12] -translate-y-1/2 border-[color-mix(in_oklab,var(--primary)_38%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_12%,var(--background))] text-primary shadow-xs enabled:hover:border-[color-mix(in_oklab,var(--primary)_54%,var(--border))] enabled:hover:bg-[color-mix(in_oklab,var(--primary)_20%,var(--background))] enabled:hover:text-primary motion-reduce:transition-none";
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

const nodeTypes = {
  reviewGroup: React.memo(ReviewGroupNode),
  fileNode: React.memo(FileNode),
  reviewSection: React.memo(ReviewSectionNode),
};
const edgeTypes = {
  reviewBranch: React.memo(ReviewBranch),
};

function App() {
  const review = useMemo(readReviewData, []);
  const treeData = useMemo(readTreeData, []);
  const hasTree = Boolean(
    (treeData?.files || []).some((file) => sectionTreeSections(file).length > 0),
  );
  const expansionStorageKey = useMemo(() => {
    return `pr-review-tree-expansion:${window.location.pathname}`;
  }, []);
  const sourceOrderViewStorageKey = useMemo(() => {
    return `pr-review-source-view:${window.location.pathname}`;
  }, []);
  const [expandedGroupIds, setExpandedGroupIds] = usePersistentStringSet(expansionStorageKey);
  const [sourceOrderViewIds, setSourceOrderViewIds] =
    usePersistentStringSet(sourceOrderViewStorageKey);
  const stacks = treeData?.reviewStacks || [];
  const [activeStackId, setActiveStackId] = useState(() => stacks[0]?.id ?? null);
  // First-pass layout uses the estimated reviewSectionHeight() formula; once
  // ReviewTreeCanvas measures real rendered heights that drift from the estimate,
  // this re-runs layout with real numbers. Rendered node ids and content are
  // stable, so measurements never need to be invalidated.
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
  const tree = useMemo(() => {
    // Always scope the canvas to one stack at a time, even when there is
    // only one: review stacks render independently, never as one combined
    // whole-PR tree.
    return buildReviewTree(treeData, {
      activeStackId,
      expandedGroupIds,
      sourceOrderViewIds,
      measuredHeights,
    });
  }, [activeStackId, expandedGroupIds, sourceOrderViewIds, measuredHeights, treeData]);
  const toggleReviewGroup = useCallback(
    (groupId) => {
      setExpandedGroupIds((current) => {
        const next = new Set(current);
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }
        return next;
      });
    },
    [setExpandedGroupIds],
  );
  const setFileViewMode = useCallback(
    (fileId, viewMode) => {
      setSourceOrderViewIds((current) => {
        const next = new Set(current);
        if (viewMode === "source") {
          next.add(fileId);
        } else {
          next.delete(fileId);
        }
        return next;
      });
    },
    [setSourceOrderViewIds],
  );

  return (
    <div className="review-shell fixed inset-0 grid h-dvh w-screen min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden bg-background">
      <ReviewHeader review={review} />
      <main className="review-main grid min-h-0 overflow-hidden">
        {hasTree ? (
          <section
            className="review-tree-panel size-full min-h-0 overflow-hidden rounded-none border-0 bg-card shadow-none"
            aria-label="PR review tree"
          >
            <ReactFlowProvider>
              <ReviewTreeCanvas
                activeStackId={activeStackId}
                tree={tree}
                onActiveStackChange={setActiveStackId}
                onFileViewModeChange={setFileViewMode}
                onMeasuredHeightsChange={handleMeasuredHeightsChange}
                onToggleReviewGroup={toggleReviewGroup}
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
            <span className="branch-name is-base min-w-0 max-w-[82px] flex-[0_1_auto] truncate">
              {review.baseRefName || "base"}
            </span>
            <span
              aria-hidden="true"
              className="branch-arrow flex-none font-extrabold text-muted-foreground"
            >
              &lt;-
            </span>
            <span className="branch-name is-head min-w-0 max-w-[138px] flex-1 truncate">
              {review.headRefName || "head"}
            </span>
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

function ReviewTreeCanvas({
  activeStackId,
  tree,
  onActiveStackChange,
  onFileViewModeChange,
  onMeasuredHeightsChange,
  onToggleReviewGroup,
  stacks,
}) {
  const reactFlow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const liveNodes = useNodes();
  const canvasRef = useRef(null);
  const currentFileNodeIdRef = useRef(null);
  const pendingSnapIdRef = useRef(null);
  const snapRetryFrameRef = useRef(null);
  const defaultViewport = tree.defaultViewport || FALLBACK_TREE_VIEWPORT;
  const reviewSteps = useMemo(() => {
    return tree.nodes.filter(({ type }) => type === "reviewSection");
  }, [tree.nodes]);
  const reviewStepIds = useMemo(() => new Set(reviewSteps.map(({ id }) => id)), [reviewSteps]);
  const reviewStepTargets = useMemo(() => {
    const targets = new Map();
    for (const step of reviewSteps) {
      targets.set(step.id, step.id);
      if (step.parentId && !targets.has(step.parentId)) {
        targets.set(step.parentId, step.id);
      }
    }
    return targets;
  }, [reviewSteps]);
  const [currentStepId, setCurrentStepId] = useState(() => reviewSteps[0]?.id ?? null);
  const navigation = useMemo(() => {
    const currentIndex = reviewSteps.findIndex(({ id }) => id === currentStepId);
    const current = reviewSteps[currentIndex] ?? null;
    const fileRoots = reviewSteps.filter(
      (step, index) => step.parentId !== reviewSteps[index - 1]?.parentId,
    );
    const currentFileIndex = fileRoots.findIndex(({ parentId }) => parentId === current?.parentId);
    return {
      current,
      currentIndex,
      next: reviewSteps[currentIndex + 1] ?? null,
      nextFile: fileRoots[currentFileIndex + 1] ?? null,
      previous: reviewSteps[currentIndex - 1] ?? null,
      previousFile: fileRoots[currentFileIndex - 1] ?? null,
    };
  }, [currentStepId, reviewSteps]);
  const snapToStep = useCallback(
    (nodeId) => {
      const stepId = reviewStepTargets.get(nodeId);
      if (!stepId) {
        return false;
      }

      setCurrentStepId(stepId);
      const node = reactFlow.getInternalNode(stepId);
      currentFileNodeIdRef.current = node?.parentId ?? currentFileNodeIdRef.current;
      const canvas = canvasRef.current;
      const nodeWidth = node?.measured?.width;
      if (!nodeWidth || !node.measured.height || !canvas) {
        pendingSnapIdRef.current = stepId;
        if (snapRetryFrameRef.current === null) {
          snapRetryFrameRef.current = window.requestAnimationFrame(() => {
            snapRetryFrameRef.current = null;
            snapToStep(pendingSnapIdRef.current);
          });
        }
        return false;
      }

      pendingSnapIdRef.current = null;
      reactFlow.setViewport(
        reviewViewportForNode(node, nodeWidth, canvas.getBoundingClientRect()),
        {
          duration: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
            ? 0
            : REVIEW_CAMERA_DURATION,
        },
      );
      return true;
    },
    [reactFlow, reviewStepTargets],
  );
  useEffect(() => {
    return () => {
      if (snapRetryFrameRef.current !== null) {
        window.cancelAnimationFrame(snapRetryFrameRef.current);
      }
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Stack changes reset the camera; layout measurement updates must not.
  useEffect(() => {
    snapToStep(reviewSteps[0]?.id);
    // Start each selected stack at its first file-tree root. Do not depend on
    // tree rebuilds here: measurement updates must not fight manual panning.
  }, [activeStackId]);
  useEffect(() => {
    if (!currentStepId || !reviewStepIds.has(currentStepId)) {
      const fallback = reviewSteps.find(
        ({ parentId }) => parentId === currentFileNodeIdRef.current,
      );
      snapToStep(fallback?.id ?? reviewSteps[0]?.id);
    }
  }, [currentStepId, reviewStepIds, reviewSteps, snapToStep]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Tree changes intentionally retry a pending snap after React Flow measures nodes.
  useEffect(() => {
    if (pendingSnapIdRef.current) {
      snapToStep(pendingSnapIdRef.current);
    }
  }, [tree.nodes, snapToStep]);
  useEffect(() => {
    if (!nodesInitialized) {
      return;
    }

    const updates = new Map();
    for (const node of liveNodes) {
      if (node.type !== "reviewSection" || !node.measured?.height || !node.data?.reviewSection) {
        continue;
      }
      const estimatedHeight = reviewSectionHeight(node.data.reviewSection);
      if (Math.abs(node.measured.height - estimatedHeight) > 2) {
        updates.set(node.id, node.measured.height);
      }
    }

    if (updates.size > 0) {
      onMeasuredHeightsChange(updates);
    }
  }, [liveNodes, nodesInitialized, onMeasuredHeightsChange]);
  const handleToggleReviewGroup = useCallback(
    (groupId) => {
      onToggleReviewGroup(groupId);
    },
    [onToggleReviewGroup],
  );
  const handleNodeClick = useCallback(
    (event, node) => {
      const target = event.target;
      if (
        !reviewStepTargets.has(node.id) ||
        window.getSelection()?.isCollapsed === false ||
        (target instanceof Element && target.closest(REVIEW_NAVIGATION_CONTROL_SELECTOR))
      ) {
        return;
      }

      snapToStep(node.id);
    },
    [reviewStepTargets, snapToStep],
  );
  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        window.getSelection()?.isCollapsed === false ||
        (target instanceof Element && target.closest(REVIEW_NAVIGATION_CONTROL_SELECTOR))
      ) {
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const destination =
          event.key === "ArrowLeft"
            ? event.shiftKey
              ? navigation.previousFile
              : navigation.previous
            : event.shiftKey
              ? navigation.nextFile
              : navigation.next;
        snapToStep(destination?.id);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigation, snapToStep]);
  const interactiveNodes = useMemo(() => {
    return tree.nodes.map((node) => {
      if (node.type === "reviewGroup") {
        return {
          ...node,
          data: {
            ...node.data,
            onToggleReviewGroup: handleToggleReviewGroup,
          },
        };
      }

      if (node.type === "fileNode") {
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
  }, [tree.nodes, handleToggleReviewGroup, onFileViewModeChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Tree changes intentionally refresh the matching React Flow DOM node.
  useEffect(() => {
    const canvas = canvasRef.current;
    let activeNode;
    let frame;
    const applyCurrentStep = () => {
      activeNode = [...(canvas?.querySelectorAll(".react-flow__node") || [])].find(
        (node) => node.dataset.id === currentStepId,
      );
      canvas?.querySelector('[aria-current="step"]')?.removeAttribute("aria-current");
      activeNode?.setAttribute("aria-current", "step");
      if (!activeNode && currentStepId) {
        frame = window.requestAnimationFrame(applyCurrentStep);
      }
    };
    applyCurrentStep();

    return () => {
      activeNode?.removeAttribute("aria-current");
      window.cancelAnimationFrame(frame);
    };
  }, [currentStepId, tree.nodes]);
  const currentStepTitle = reviewStepTitle(navigation.current);
  return (
    <div
      className="review-tree relative grid size-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-card"
      data-review-tree
    >
      <div
        className="tree-canvas relative col-start-1 row-start-1 size-full min-h-0 min-w-0"
        ref={canvasRef}
      >
        <ReactFlow
          colorMode={INITIAL_COLOR_MODE}
          defaultViewport={defaultViewport}
          edges={tree.edges}
          edgeTypes={edgeTypes}
          maxZoom={1.7}
          minZoom={MIN_TREE_ZOOM}
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
            color="color-mix(in oklab, var(--section-tree-color) 24%, var(--border))"
            gap={24}
            size={1.2}
            variant={BackgroundVariant.Dots}
          />
          <MiniMap
            ariaLabel="Review tree map"
            className="review-tree-map"
            nodeClassName={reviewTreeMapNodeClassName}
            nodeColor={reviewTreeMapNodeColor}
            nodeComponent={ReviewTreeMapNode}
            nodeStrokeColor={(node) =>
              node.id === currentStepId ? "var(--primary)" : "transparent"
            }
            nodeStrokeWidth={4}
            onNodeClick={(event, node) => {
              event.stopPropagation();
              snapToStep(node.id);
            }}
            pannable
            position="top-right"
            style={{ right: 18, top: 16 }}
            zoomable={false}
          />
        </ReactFlow>
        <StackSelect
          activeStackId={activeStackId}
          onActiveStackChange={onActiveStackChange}
          stacks={stacks}
        />
        <Button
          aria-label={
            navigation.previousFile
              ? `Previous file: ${reviewStepTitle(navigation.previousFile)}`
              : "No previous file"
          }
          className={`${REVIEW_STEP_BUTTON_CLASS} is-previous-file left-4 top-[calc(50%_+_26px)]`}
          disabled={!navigation.previousFile}
          onClick={() => snapToStep(navigation.previousFile?.id)}
          size="icon-lg"
          title={
            navigation.previousFile
              ? `Previous file: ${reviewStepTitle(navigation.previousFile)}`
              : "First file"
          }
          type="button"
          variant="outline"
        >
          <ChevronsLeft aria-hidden="true" />
        </Button>
        <Button
          aria-label={
            navigation.previous
              ? `Previous review step: ${reviewStepTitle(navigation.previous)}`
              : "No previous review step"
          }
          className={`${REVIEW_STEP_BUTTON_CLASS} is-previous left-4 top-[calc(50%_-_26px)]`}
          disabled={!navigation.previous}
          onClick={() => snapToStep(navigation.previous?.id)}
          size="icon-lg"
          title={
            navigation.previous ? `Previous: ${reviewStepTitle(navigation.previous)}` : "First step"
          }
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
          <span aria-hidden="true">{`${Math.max(0, navigation.currentIndex + 1)} / ${reviewSteps.length}`}</span>
          <span className="sr-only">
            {navigation.current
              ? `Moved to ${currentStepTitle}, step ${navigation.currentIndex + 1} of ${reviewSteps.length}`
              : "No visible review steps"}
          </span>
        </Badge>
        <Button
          aria-label={
            navigation.next
              ? `Next review step: ${reviewStepTitle(navigation.next)}`
              : "No next review step"
          }
          className={`${REVIEW_STEP_BUTTON_CLASS} is-next right-4 top-[calc(50%_-_26px)]`}
          disabled={!navigation.next}
          onClick={() => snapToStep(navigation.next?.id)}
          size="icon-lg"
          title={navigation.next ? `Next: ${reviewStepTitle(navigation.next)}` : "Last step"}
          type="button"
          variant="outline"
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <Button
          aria-label={
            navigation.nextFile
              ? `Next file: ${reviewStepTitle(navigation.nextFile)}`
              : "No next file"
          }
          className={`${REVIEW_STEP_BUTTON_CLASS} is-next-file right-4 top-[calc(50%_+_26px)]`}
          disabled={!navigation.nextFile}
          onClick={() => snapToStep(navigation.nextFile?.id)}
          size="icon-lg"
          title={
            navigation.nextFile ? `Next file: ${reviewStepTitle(navigation.nextFile)}` : "Last file"
          }
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
    MIN_TREE_ZOOM,
    Math.min(REVIEW_STEP_MAX_ZOOM, (canvasBounds.width - REVIEW_CAMERA_PADDING_X * 2) / nodeWidth),
  );

  return {
    x: Math.round(canvasBounds.width / 2 - (x + nodeWidth / 2) * zoom),
    y: Math.round(VIEWPORT_PADDING_Y - y * zoom),
    zoom,
  };
}

function reviewStepTitle(step) {
  return step?.data?.reviewSection?.title || step?.data?.file?.path || "review step";
}

function reviewTreeMapNodeColor(node) {
  if (node.type === "fileNode") {
    return "color-mix(in oklab, var(--card) 90%, var(--section-tree-color))";
  }

  return (
    {
      primary: "var(--coral)",
      secondary: "var(--ochre)",
      skim: "var(--muted-foreground)",
    }[node.data?.reviewSection?.reviewPriority] || "var(--section-tree-color)"
  );
}

function reviewTreeMapNodeClassName(node) {
  return `is-${node.type} is-${node.data?.reviewSection?.reviewPriority || "file"}`;
}

function ReviewTreeMapNode({
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
  const isFileNode = className.includes("is-fileNode");
  const isGroup = className.includes("is-reviewGroup");
  const headerHeight = isFileNode ? Math.max(36, height * 0.05) : Math.max(24, height * 0.18);
  const lineWidth = Math.max(10, Math.min(width, height) * 0.035);

  return (
    <a
      aria-label={`Focus ${id} in the review tree`}
      className={`react-flow__minimap-node ${className}`}
      href={`#${id}`}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event, id);
      }}
    >
      <rect
        fill={isFileNode ? color : "var(--card)"}
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
        opacity={isFileNode ? 0.45 : 0.8}
        rx={borderRadius}
        ry={borderRadius}
        width={width}
        x={x}
        y={y}
      />
      {!isFileNode && !isGroup
        ? [0.48, 0.64, 0.8].map((offset, index) => (
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
          ))
        : null}
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
    </a>
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

function FileNode({ data }) {
  const filePath = data.file?.path || "Unknown file";
  const viewMode = data.viewMode === "source" ? "source" : "tree";
  const fileExplanation = data.file?.explanation || "";

  return (
    <section
      aria-label={`File review tree for ${filePath}`}
      className="file-node relative size-full rounded-lg border border-[color-mix(in_oklab,var(--primary)_34%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_5%,var(--card))]"
    >
      <Handle
        className="node-handle"
        id={FILE_TREE_TARGET_HANDLE}
        position={Position.Top}
        type="target"
      />
      <Handle
        className="node-handle"
        id={FILE_TREE_SOURCE_HANDLE}
        position={Position.Bottom}
        type="source"
      />
      <div className="file-node-header absolute top-[11px] right-3.5 left-3.5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5">
        <ExplanationHoverCard
          explanation={fileExplanation}
          contextLabel="File: What / Why"
          side="bottom"
          title={filePath}
        >
          <Badge
            className="file-node-label max-w-full min-w-0 justify-self-start gap-2 overflow-hidden px-2.5 py-2 font-mono text-[13px] leading-none font-bold tracking-normal whitespace-nowrap text-primary select-none [&>span]:min-w-0 [&>span]:truncate data-[has-explanation=true]:pointer-events-auto data-[has-explanation=true]:cursor-help"
            data-has-explanation={Boolean(fileExplanation)}
            tabIndex={fileExplanation ? 0 : undefined}
            title={filePath}
            variant="outline"
          >
            <FileCode2 aria-hidden="true" size={16} />
            <span>{filePath}</span>
          </Badge>
        </ExplanationHoverCard>
        <Tabs
          className="file-node-view-tabs nodrag nopan pointer-events-auto gap-0 select-none"
          onValueChange={(nextMode) => data.onFileViewModeChange?.(data.file.id, nextMode)}
          value={viewMode}
        >
          <TabsList aria-label={`${filePath} view`} className="file-node-view-tabs-list w-[136px]">
            <TabsTrigger className="file-node-view-tab text-[11px]" value="tree">
              <GitBranch aria-hidden="true" size={14} />
              Tree
            </TabsTrigger>
            <TabsTrigger className="file-node-view-tab text-[11px]" value="source">
              <FileDiff aria-hidden="true" size={14} />
              Source
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </section>
  );
}

function ReviewGroupNode({ data }) {
  const group = data.reviewSection.reviewGroup;
  const reviewPriority = data.reviewSection.reviewPriority;
  const action = group.expanded ? "Collapse" : "Expand";
  const rootPreview = group.rootTitles.slice(0, 3).join(", ");

  return (
    <ExplanationHoverCard
      explanation={data.reviewSection.explanation}
      contextLabel="Review group: What / Why"
      title={data.reviewSection.title}
    >
      <Collapsible
        asChild
        onOpenChange={(expanded) => {
          if (expanded !== group.expanded) {
            data.onToggleReviewGroup(group.groupId);
          }
        }}
        open={group.expanded}
      >
        <article
          className={cn(
            "review-group nodrag nopan size-full overflow-hidden rounded-md border border-border bg-card shadow-sm",
            reviewPriority === "primary" &&
              "border-[color-mix(in_oklab,var(--coral)_46%,var(--border))] bg-[color-mix(in_oklab,var(--coral)_6%,var(--card))]",
            reviewPriority === "secondary" &&
              "border-[color-mix(in_oklab,var(--ochre)_46%,var(--border))] bg-[color-mix(in_oklab,var(--ochre)_6%,var(--card))]",
            reviewPriority === "skim" &&
              "border-[color-mix(in_oklab,var(--muted-foreground)_34%,var(--border))] bg-[color-mix(in_oklab,var(--muted)_46%,var(--card))]",
          )}
        >
          <Handle className="node-handle" position={Position.Top} type="target" />
          <CollapsibleTrigger asChild>
            <Button
              aria-label={`${action} ${data.reviewSection.title}`}
              className="review-group-button grid size-full cursor-pointer grid-cols-[44px_minmax(0,1fr)_28px] items-center gap-3 border-0 bg-transparent px-4 py-3.5 text-left font-[inherit] tracking-normal text-foreground"
              title={`${action}: ${rootPreview}`}
              type="button"
              variant="ghost"
            >
              <span
                className={cn(
                  "review-group-icon grid size-[42px] place-items-center rounded-sm border border-[color-mix(in_oklab,currentColor_18%,var(--border))] bg-muted text-coral-strong",
                  reviewPriority === "secondary" && "text-ochre-strong",
                  reviewPriority === "skim" && "text-muted-foreground",
                )}
              >
                <FolderTree aria-hidden="true" size={20} />
              </span>
              <span className="review-group-copy grid min-w-0 gap-[5px]">
                <span className="review-group-title truncate text-sm leading-[1.1] font-extrabold">
                  {data.reviewSection.title}
                </span>
                <span className="review-group-summary truncate font-mono text-[11px] leading-[1.15] font-semibold tracking-normal text-muted-foreground">
                  {`${group.branchCount} ${group.branchCount === 1 ? "branch" : "branches"} · ${group.sectionCount} sections · ${group.lineCount} changed lines`}
                </span>
                <span className="review-group-preview truncate text-[11px] leading-[1.15] tracking-normal text-muted-foreground">
                  {rootPreview}
                </span>
              </span>
              <span className="review-group-toggle grid size-7 place-items-center rounded-sm text-muted-foreground">
                {group.expanded ? (
                  <ChevronDown aria-hidden="true" size={19} />
                ) : (
                  <ChevronRight aria-hidden="true" size={19} />
                )}
              </span>
            </Button>
          </CollapsibleTrigger>
          <Handle className="node-handle" position={Position.Bottom} type="source" />
        </article>
      </Collapsible>
    </ExplanationHoverCard>
  );
}

function ReviewSectionNode({ data }) {
  const filePath = data.file?.path || "Unknown file";
  const reviewPriority = data.reviewSection.reviewPriority || "unknown";
  const showHandles = !data.reviewSection.sourceOrderView;

  const sectionExplanation = data.reviewSection.explanation || "";

  return (
    <article
      aria-label={`Review section for ${filePath}: ${data.reviewSection.title}. ${plainTextExplanation(sectionExplanation)}`}
      className={cn(
        "review-section-node nodrag nopan w-full max-w-full cursor-text overflow-hidden rounded-md border border-border bg-card shadow-sm select-text",
        reviewPriority === "primary" &&
          "border-[color-mix(in_oklab,var(--coral)_46%,var(--border))]",
        reviewPriority === "secondary" &&
          "border-[color-mix(in_oklab,var(--ochre)_46%,var(--border))]",
        reviewPriority === "skim" &&
          "border-[color-mix(in_oklab,var(--muted-foreground)_34%,var(--border))]",
      )}
      data-file-path={filePath}
    >
      {showHandles ? (
        <Handle className="node-handle" position={Position.Top} type="target" />
      ) : null}
      <ExplanationHoverCard
        explanation={sectionExplanation}
        contextLabel="Review section: What / Why"
        title={data.reviewSection.title}
      >
        <header
          className={cn(
            "review-section-header flex h-[42px] w-full min-w-0 items-center overflow-hidden border-b border-border bg-muted px-3 text-xs leading-none text-card-foreground outline-none data-[slot=hover-card-trigger]:cursor-help focus-visible:shadow-[inset_0_0_0_3px_color-mix(in_oklab,var(--ring)_30%,transparent)]",
            reviewPriority === "primary" && "bg-[color-mix(in_oklab,var(--coral)_9%,var(--muted))]",
            reviewPriority === "secondary" &&
              "bg-[color-mix(in_oklab,var(--ochre)_9%,var(--muted))]",
          )}
          tabIndex={sectionExplanation ? 0 : undefined}
        >
          <span
            className="review-section-title min-w-0 truncate text-xs font-bold tracking-normal"
            title={data.reviewSection.title}
          >
            {data.reviewSection.title}
          </span>
        </header>
      </ExplanationHoverCard>
      <div className="review-section-scroll max-w-full overflow-x-auto overflow-y-hidden overscroll-contain">
        {(data.reviewSection.codeChunks || []).map((chunk, chunkIndex, chunks) => (
          <React.Fragment
            key={`${data.reviewSection.id}-${chunk.lines[0]?.id}-${chunk.lines.at(-1)?.id}`}
          >
            <UnchangedLinesGap nextChunk={chunk} prevChunk={chunks[chunkIndex - 1]} />
            <DiffChunkView chunk={chunk} />
          </React.Fragment>
        ))}
      </div>
      {showHandles ? (
        <Handle className="node-handle" position={Position.Bottom} type="source" />
      ) : null}
    </article>
  );
}

function ReviewBranch({
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
  const explanation = data?.explanation || "";
  const sourceTitle = data?.sourceTitle || "Parent";
  const targetTitle = data?.targetTitle || "Child";

  return (
    <ExplanationHoverCard
      explanation={explanation}
      contextLabel="Review branch: What / Why"
      side="top"
      title={`${sourceTitle} → ${targetTitle}`}
    >
      <a
        aria-label={`${sourceTitle} to ${targetTitle}. ${plainTextExplanation(explanation)}`}
        className="review-branch-trigger"
        href={`#${id}`}
        onClick={(event) => event.preventDefault()}
      >
        <title>{`${sourceTitle} to ${targetTitle}. ${plainTextExplanation(explanation)}`}</title>
        <BaseEdge
          className="review-branch-path"
          id={id}
          interactionWidth={0}
          markerEnd={markerEnd}
          path={edgePath}
          style={style}
        />
        <path className="review-branch-hit-path" d={edgePath} />
      </a>
    </ExplanationHoverCard>
  );
}

function ExplanationHoverCard({ children, explanation, contextLabel, side = "top", title }) {
  const text = String(explanation || "").trim();
  if (!text) {
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
        <div className="explanation-hover-label text-[11px] leading-[1.2] font-extrabold tracking-normal text-primary uppercase">
          {contextLabel}
        </div>
        <div className="explanation-hover-title mt-1.5 text-sm leading-[1.35] font-extrabold tracking-normal text-foreground [overflow-wrap:anywhere]">
          {title}
        </div>
        <div className="explanation-hover-body mt-2.5 text-[13px] leading-[1.55] text-muted-foreground [overflow-wrap:anywhere]">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function plainTextExplanation(explanation) {
  return String(explanation || "")
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
    <div className="review-section-gap-divider border-y border-border bg-[color-mix(in_oklab,var(--muted)_45%,var(--card))] px-2.5 py-[3px] text-[10px] font-semibold tracking-[0.02em] text-muted-foreground">
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
        className="review-section-code"
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

function buildReviewTree(
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
          "This view keeps every changed hunk together in source order for reviewers who prefer top-to-bottom file context. It intentionally presents source order rather than the Section Tree.",
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

function sectionTreeSections(file) {
  return normalizeSectionTree(file).sections;
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

function readTreeData() {
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
