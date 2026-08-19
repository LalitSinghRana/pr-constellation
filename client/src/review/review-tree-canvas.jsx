import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useNodes,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Layers3 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.jsx";
import { useSettingsQuery } from "../hooks/use-settings.js";
import { useReviewDraft } from "./review-draft-panel.jsx";
import {
  FALLBACK_TREE_VIEWPORT,
  MIN_TREE_ZOOM,
  reviewSectionHeight,
  VIEWPORT_PADDING_Y,
} from "./review-tree/layout.js";
import { edgeTypes, nodeTypes } from "./review-tree-nodes.jsx";

const INITIAL_COLOR_MODE = document.documentElement.classList.contains("dark") ? "dark" : "light";
const REVIEW_CAMERA_DURATION = 220;
const REVIEW_CAMERA_PADDING_X = 80;
const REVIEW_STEP_MAX_ZOOM = 1.25;
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

export function ReviewTreeCanvas({
  activeStackId,
  tree,
  onActiveStackChange,
  onFileViewModeChange,
  onMeasuredHeightsChange,
  onToggleReviewGroup,
  stacks,
}) {
  const draft = useReviewDraft();
  const commentIndex = draft.commentIndex;
  const headStale = draft.headStale;
  const onLineComment = draft.openComposer;
  const draftComment = useMemo(
    () => ({
      activeEntry: draft.activeCommentEntry,
      body: draft.composerBody,
      cancelComposer: draft.cancelComposer,
      headStale: draft.headStale,
      pendingTarget: draft.pendingTarget,
      saveComment: () =>
        draft.saveComment().catch((saveError) => draft.setError(saveError.message)),
      setBody: draft.setComposerBody,
    }),
    [
      draft.activeCommentEntry,
      draft.cancelComposer,
      draft.composerBody,
      draft.headStale,
      draft.pendingTarget,
      draft.saveComment,
      draft.setComposerBody,
      draft.setError,
    ],
  );
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
  const settingsQuery = useSettingsQuery();
  const showMinimap = settingsQuery.data?.showMinimap === true;
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

      if (node.type === "reviewSection") {
        return {
          ...node,
          data: {
            ...node.data,
            commentIndex,
            draftComment,
            headStale,
            onLineComment,
          },
        };
      }

      return node;
    });
  }, [
    commentIndex,
    draftComment,
    headStale,
    onLineComment,
    tree.nodes,
    handleToggleReviewGroup,
    onFileViewModeChange,
  ]);
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
          {showMinimap ? (
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
          ) : null}
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
