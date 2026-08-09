import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  getSmoothStepPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodes,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleDot,
  CircleX,
  FileCode2,
  FileDiff,
  FileText,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  Layers3,
  MessageSquare,
  RotateCcw,
  UserRoundPlus,
} from "lucide-react";
import { Timeline } from "primereact/timeline";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { remarkAlert } from "remark-github-blockquote-alert";
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
import { githubMarkdownSanitizeSchema } from "./github-markdown.js";
import { lineKey, lineTargetFromGutter } from "./review-comment-model.js";
import { InlineCommentComposer, ReviewDraftProvider } from "./review-draft-panel.jsx";
import {
  buildReviewTree,
  FALLBACK_TREE_VIEWPORT,
  FILE_TREE_SOURCE_HANDLE,
  FILE_TREE_TARGET_HANDLE,
  MIN_TREE_ZOOM,
  sectionTreeSections,
  VIEWPORT_PADDING_Y,
} from "./review-tree/layout.js";
import {
  readReviewData,
  readReviewSlug,
  readTreeData,
  usePersistentStringSet,
} from "./review-tree/state.js";

const REVIEW_CAMERA_DURATION = 220;
const REVIEW_CAMERA_PADDING_X = 80;
const REVIEW_STEP_MAX_ZOOM = 1.25;
const INITIAL_COLOR_MODE = document.documentElement.classList.contains("dark") ? "dark" : "light";
const REVIEW_STEP_BUTTON_CLASS =
  "review-step-button absolute z-[12] -translate-y-1/2 border-[color-mix(in_oklab,var(--primary)_38%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_12%,var(--background))] text-primary shadow-xs enabled:hover:border-[color-mix(in_oklab,var(--primary)_54%,var(--border))] enabled:hover:bg-[color-mix(in_oklab,var(--primary)_20%,var(--background))] enabled:hover:text-primary motion-reduce:transition-none";
const REVIEW_DIFF_GUTTER_CLASS =
  "cursor-pointer relative select-none hover:bg-primary/12 hover:text-primary";
const REVIEW_DIFF_GUTTER_HAS_COMMENT_CLASS = "text-primary font-bold";
const REVIEW_DIFF_GUTTER_ACTIVE_CLASS = "bg-primary/18 text-primary font-bold";
const REVIEW_LINE_COMMENT_MARKER_CLASS =
  "absolute top-1/2 right-px size-2 border-0 p-0 rounded-full -translate-y-1/2 bg-primary cursor-pointer shadow-[0_0_0_2px_color-mix(in_oklab,var(--card)_80%,transparent)]";
const REVIEW_LINE_COMMENT_MARKER_GITHUB_CLASS = "bg-[color-mix(in_oklab,var(--primary)_55%,white)]";
const REVIEW_INLINE_COMPOSER_ANCHOR_CLASS = "fixed z-[200] pointer-events-auto";
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
  const reviewSlug = useMemo(readReviewSlug, []);
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
  const [activeTab, setActiveTab] = useState("conversation");
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
    <ReviewDraftProvider reviewSlug={reviewSlug} showReviewSheet={activeTab === "trees"}>
      {(draft) => (
        <div className="review-shell fixed inset-0 grid h-dvh w-screen min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden bg-background">
          <ReviewHeader activeTab={activeTab} onTabChange={setActiveTab} review={review} />
          <main className="review-main grid min-h-0 overflow-hidden">
            {activeTab === "conversation" ? (
              <PullRequestConversation review={review} reviewSlug={reviewSlug} />
            ) : hasTree ? (
              <section
                className="review-tree-panel size-full min-h-0 overflow-hidden rounded-none border-0 bg-card shadow-none"
                aria-label="PR review tree"
              >
                <ReactFlowProvider>
                  <ReviewTreeCanvas
                    activeStackId={activeStackId}
                    commentIndex={draft.commentIndex}
                    draftComment={{
                      activeEntry: draft.activeCommentEntry,
                      body: draft.composerBody,
                      cancelComposer: draft.cancelComposer,
                      headStale: draft.headStale,
                      pendingTarget: draft.pendingTarget,
                      saveComment: () =>
                        draft.saveComment().catch((saveError) => draft.setError(saveError.message)),
                      setBody: draft.setComposerBody,
                    }}
                    headStale={draft.headStale}
                    onLineComment={draft.openComposer}
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
      )}
    </ReviewDraftProvider>
  );
}

function ReviewHeader({ activeTab, onTabChange, review }) {
  return (
    <header className="review-header sticky top-0 z-20 border-b border-border bg-[color-mix(in_oklab,var(--card)_92%,var(--background))] px-5 py-3 shadow-xs backdrop-blur-[20px] max-[980px]:px-3 max-[980px]:py-2.5">
      <div className="review-header-main grid grid-cols-[minmax(0,1fr)_auto] items-center justify-between gap-3.5 max-[980px]:grid-cols-1 max-[980px]:gap-2">
        <div className="review-title-row flex min-w-0 flex-auto items-center gap-2.5 max-[980px]:flex-wrap max-[980px]:gap-2">
          <div
            className={cn(
              "review-eyebrow flex flex-none items-center gap-[7px] text-xs font-bold tracking-[0.08em] text-primary uppercase",
            )}
          >
            <span
              className={cn(
                "review-mark inline-flex size-7 items-center justify-center rounded-md border shadow-xs",
                pullRequestStateClass(review),
              )}
              title={pullRequestStateLabel(review)}
            >
              <GitPullRequest aria-hidden="true" size={16} />
              <span className="sr-only">{pullRequestStateLabel(review)}</span>
            </span>
            <span>{`PR #${review.number || "unknown"}`}</span>
          </div>
          <h1 className="review-title m-0 min-w-[120px] flex-auto truncate font-display text-xl leading-[1.2] font-bold tracking-normal text-foreground max-[980px]:order-2 max-[980px]:basis-full max-[980px]:text-lg [&_a]:no-underline [&_a:hover]:text-primary">
            <a href={review.url}>{review.title || "Untitled pull request"}</a>
          </h1>
        </div>
        <Tabs onValueChange={onTabChange} value={activeTab}>
          <TabsList aria-label="Review content">
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
            <TabsTrigger value="trees">Review trees</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </header>
  );
}

function PullRequestConversation({ review, reviewSlug }) {
  const [conversation, setConversation] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/reviews/${encodeURIComponent(reviewSlug)}/conversation`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Conversation could not be loaded.");
        setConversation(payload);
      })
      .catch((loadError) => {
        if (loadError.name !== "AbortError") setError(loadError.message);
      });
    return () => controller.abort();
  }, [reviewSlug]);

  if (error) return <p className="m-auto text-sm text-destructive">{error}</p>;
  if (!conversation)
    return <p className="m-auto text-sm text-muted-foreground">Loading conversation…</p>;

  const timeline = [
    ...(review.body.trim()
      ? [
          {
            actor: review.authorLogin || "Author",
            avatarUrl: review.authorAvatarUrl,
            body: review.body,
            createdAt: review.createdAt,
            kind: "description",
            type: "PullRequest",
            url: review.url,
          },
        ]
      : []),
    ...conversation.timeline,
    ...conversation.threads.map((thread) => ({
      actor: thread.comments[0]?.actor || "GitHub",
      avatarUrl: thread.comments[0]?.avatarUrl || "",
      createdAt: thread.comments[0]?.createdAt || "",
      kind: "thread",
      thread,
      type: "PullRequestReviewThread",
    })),
  ].sort((left, right) => timelineTimestamp(left) - timelineTimestamp(right));

  return (
    <section
      aria-label="Pull request conversation"
      className="flex min-h-0 min-w-0 items-start justify-center overflow-auto bg-card px-5 py-6 max-[980px]:px-3"
    >
      {timeline.length === 0 ? (
        <p className="text-sm text-muted-foreground">No conversation yet.</p>
      ) : (
        <Timeline
          className="conversation-timeline w-full min-w-0 max-w-5xl"
          content={(item) => <ConversationItem item={item} />}
          marker={(item) => {
            const Icon = conversationIcon(item);
            return (
              <span
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full border-2 border-background",
                  conversationIconClass(item),
                )}
              >
                <Icon aria-hidden size={13} strokeWidth={2.5} />
              </span>
            );
          }}
          pt={{
            connector: { className: "conversation-timeline-connector" },
            content: { className: "conversation-timeline-content" },
            event: { className: "conversation-timeline-event" },
            opposite: { className: "conversation-timeline-opposite" },
            separator: { className: "conversation-timeline-separator" },
          }}
          unstyled
          value={timeline}
        />
      )}
    </section>
  );
}

function ConversationItem({ item }) {
  const label = conversationLabel(item);
  const isContent =
    ["comment", "description", "thread"].includes(item.kind) ||
    (item.kind === "review" && Boolean(item.body.trim()));
  return (
    <article
      className={cn(
        "relative min-w-0 text-sm",
        isContent ? "rounded-lg border bg-background p-4" : "flex items-center py-1.5",
      )}
    >
      <p
        className={cn(
          "min-w-0 font-semibold text-muted-foreground",
          isContent ? "text-xs" : "truncate",
        )}
      >
        {item.actor} {label}
      </p>
      {item.kind === "thread" ? <ConversationThread thread={item.thread} /> : null}
      {isContent && item.body ? <ConversationMarkdown body={item.body} /> : null}
    </article>
  );
}

function ConversationThread({ thread }) {
  return (
    <div className="mt-3 grid gap-3">
      <p className="font-mono text-xs text-muted-foreground">
        {thread.path}:{thread.line}
        {thread.isResolved ? " · resolved" : ""}
        {thread.isOutdated ? " · outdated" : ""}
      </p>
      {thread.comments.map((comment) => (
        <div className="border-t pt-3" key={comment.id || comment.createdAt}>
          <p className="text-xs font-semibold text-muted-foreground">{comment.actor}</p>
          <ConversationMarkdown body={comment.body} />
        </div>
      ))}
    </div>
  );
}

function ConversationMarkdown({ body }) {
  return (
    <div className="conversation-markdown mt-3 min-w-0 break-words leading-6">
      <ReactMarkdown
        components={{ table: MarkdownTable }}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, githubMarkdownSanitizeSchema]]}
        remarkPlugins={[remarkGfm, remarkAlert]}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownTable({ children }) {
  return (
    <div className="my-3 overflow-x-auto rounded-md border border-border">
      <table className="conversation-markdown-table">{children}</table>
    </div>
  );
}

function conversationLabel(item) {
  if (item.kind === "description") return "opened this pull request";
  if (item.kind === "review") return `submitted ${item.state.toLowerCase().replaceAll("_", " ")}`;
  if (item.kind === "thread") return "reviewed a file";
  if (item.kind === "commit") return `pushed ${item.body.split("\n", 1)[0] || "a commit"}`;
  if (item.type === "ReviewRequestedEvent")
    return `requested review from ${item.requestedReviewer || "a reviewer"}`;
  if (item.kind === "event")
    return String(item.type)
      .replace(/Event$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase();
  return "commented";
}

function conversationIcon(item) {
  if (item.kind === "description") return GitPullRequest;
  if (item.kind === "comment" || item.kind === "thread") return MessageSquare;
  if (item.kind === "review" && item.state === "APPROVED") return Check;
  if (item.kind === "review" && item.state === "COMMENTED") return MessageSquare;
  if (item.kind === "review") return FileText;
  if (item.kind === "commit") return GitCommitHorizontal;
  if (item.type === "ReviewRequestedEvent") return UserRoundPlus;
  if (item.type === "MergedEvent") return GitMerge;
  if (item.type === "ClosedEvent") return CircleX;
  if (item.type === "HeadRefForcePushedEvent") return RotateCcw;
  if (item.type === "CrossReferencedEvent") return GitPullRequestArrow;
  return CircleDot;
}

function conversationIconClass(item) {
  if (item.type === "MergedEvent") return "bg-pr-merged text-background";
  if (item.type === "ClosedEvent") return "bg-pr-closed text-background";
  if (item.kind === "description") return "bg-pr-open text-background";
  if (item.kind === "review" && item.state === "APPROVED") return "bg-pr-open text-background";
  if (
    item.kind === "comment" ||
    item.kind === "thread" ||
    (item.kind === "review" && item.state === "COMMENTED")
  )
    return "bg-background text-muted-foreground";
  if (item.kind === "review") return "bg-primary text-primary-foreground";
  return "bg-muted text-muted-foreground";
}

function timelineTimestamp(item) {
  if (item.kind === "description") return 0;
  const value = new Date(item.createdAt).getTime();
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

function ReviewTreeCanvas({
  activeStackId,
  commentIndex,
  draftComment,
  headStale,
  onLineComment,
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
        <ExplanationHoverCard explanation={fileExplanation} side="bottom">
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
    <ExplanationHoverCard explanation={data.reviewSection.explanation}>
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
      <ExplanationHoverCard explanation={sectionExplanation}>
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
            <DiffChunkView
              chunk={chunk}
              commentIndex={data.commentIndex}
              draftComment={data.draftComment}
              headStale={data.headStale}
              onLineComment={data.onLineComment}
            />
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
    <ExplanationHoverCard explanation={explanation} side="top">
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

function ExplanationHoverCard({ children, explanation, side = "top" }) {
  const text = String(explanation || "").trim();
  if (!text) {
    return children;
  }

  return (
    <HoverCard closeDelay={120} openDelay={220}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="explanation-hover-card nodrag nopan nowheel max-h-[min(640px,calc(100vh_-_32px))] w-[min(520px,calc(100vw_-_32px))] overflow-x-hidden overflow-y-auto border-border bg-popover text-popover-foreground shadow-md"
        side={side}
        sideOffset={10}
      >
        <div className="explanation-hover-body text-base leading-relaxed font-medium text-foreground [overflow-wrap:anywhere] [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.92em] [&_code]:text-foreground [&_li]:pl-0.5 [&_li]:marker:text-muted-foreground [&_ol]:my-3 [&_ol]:grid [&_ol]:gap-2 [&_ol]:pl-5 [&_p]:my-2.5 [&_ul]:my-3 [&_ul]:grid [&_ul]:gap-2 [&_ul]:pl-5">
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

function pullRequestStateClass(review) {
  const state = String(review?.state || "").toUpperCase();
  if (state === "MERGED") {
    return "border-pr-merged/40 bg-pr-merged/15 text-pr-merged";
  }
  if (state === "CLOSED") {
    return "border-pr-closed/40 bg-pr-closed/15 text-pr-closed";
  }
  if (state === "DRAFT" || review?.isDraft) {
    return "border-pr-draft/40 bg-pr-draft/15 text-pr-draft";
  }
  return "border-pr-open/40 bg-pr-open/15 text-pr-open";
}

function pullRequestStateLabel(review) {
  const state = String(review?.state || "").toUpperCase();
  if (state === "MERGED") return "Merged pull request";
  if (state === "CLOSED") return "Closed pull request";
  if (state === "DRAFT" || review?.isDraft) return "Draft pull request";
  return "Open pull request";
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

function DiffChunkView({ chunk, commentIndex, draftComment, headStale, onLineComment }) {
  const { data, realNewLineNumbers, realOldLineNumbers, registerHighlighter } = useMemo(
    () => buildChunkDiffData(chunk),
    [chunk],
  );
  const containerRef = useRef(null);
  const [composerLayout, setComposerLayout] = useState(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    const abort = new AbortController();
    let decorating = false;

    const decorateGutters = () => {
      if (decorating) {
        return;
      }
      decorating = true;
      try {
        const decorateSide = (attributeName, side, realLineNumbers) => {
          container.querySelectorAll(`[${attributeName}]`).forEach((el) => {
            const index = Number(el.getAttribute(attributeName)) - 1;
            const real = realLineNumbers[index];

            if (real == null) {
              return;
            }

            const lineLabel = String(real);
            if (!el.dataset.reviewLineLabel) {
              el.dataset.reviewLineLabel = lineLabel;
            }
            const labelNode = [...el.childNodes].find(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
            );
            if (labelNode) {
              if (labelNode.textContent.trim() !== lineLabel) {
                labelNode.textContent = lineLabel;
              }
            } else if (![...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE)) {
              el.insertBefore(document.createTextNode(lineLabel), el.firstChild);
            }

            el.dataset.reviewLine = lineLabel;
            el.dataset.reviewSide = side;
            el.dataset.reviewPath = chunk.file;
            el.dataset.reviewGutter = "true";
            el.classList.add(...REVIEW_DIFF_GUTTER_CLASS.split(/\s+/));

            const row = el.closest("tr") || el.closest(".diff-line") || el.parentElement;
            if (row) {
              row.dataset.reviewDiffLine = "true";
            }

            syncGutterCommentMarker(el, {
              commentIndex,
              line: real,
              path: chunk.file,
              side,
            });
          });
        };

        decorateSide("data-line-old-num", "LEFT", realOldLineNumbers);
        decorateSide("data-line-new-num", "RIGHT", realNewLineNumbers);
      } finally {
        decorating = false;
      }
    };

    decorateGutters();
    const openLineCommentFromEvent = (event) => {
      if (headStale || !onLineComment) {
        return;
      }
      const gutter = event.target.closest("[data-review-gutter]");
      if (!gutter || !container.contains(gutter)) {
        return;
      }
      const target = lineTargetFromGutter(gutter);
      if (!target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onLineComment(target);
    };
    container.addEventListener("click", openLineCommentFromEvent, { signal: abort.signal });
    const observer = new MutationObserver(decorateGutters);
    observer.observe(container, { characterData: true, childList: true, subtree: true });

    return () => {
      abort.abort();
      observer.disconnect();
    };
  }, [chunk.file, commentIndex, headStale, onLineComment, realNewLineNumbers, realOldLineNumbers]);

  useEffect(() => {
    const container = containerRef.current;
    const target = draftComment?.pendingTarget;

    if (!container || !target || target.path !== chunk.file) {
      clearActiveDiffLine(container);
      setComposerLayout(null);
      return undefined;
    }

    let frame = 0;
    const syncComposerLayout = () => {
      const gutter = [...container.querySelectorAll("[data-review-gutter]")].find(
        (element) =>
          element.dataset.reviewLine === String(target.line) &&
          element.dataset.reviewSide === target.side,
      );
      if (!gutter) {
        clearActiveDiffLine(container);
        setComposerLayout(null);
        return;
      }

      const row =
        gutter.closest("[data-review-diff-line]") ||
        gutter.closest("tr") ||
        gutter.closest(".diff-line") ||
        gutter.parentElement;
      if (!row) {
        clearActiveDiffLine(container);
        setComposerLayout(null);
        return;
      }

      clearActiveDiffLine(container);
      row.dataset.reviewDiffLineActive = "true";
      row.querySelectorAll("[data-review-gutter]").forEach((activeGutter) => {
        activeGutter.classList.add(...REVIEW_DIFF_GUTTER_ACTIVE_CLASS.split(/\s+/));
      });
      setComposerLayout(measureFixedComposer(row));
    };

    const tick = () => {
      syncComposerLayout();
      frame = window.requestAnimationFrame(tick);
    };
    tick();

    return () => {
      window.cancelAnimationFrame(frame);
      clearActiveDiffLine(container);
      setComposerLayout(null);
    };
  }, [chunk.file, draftComment?.pendingTarget]);

  const handleChunkClick = useCallback(
    (event) => {
      if (headStale || !onLineComment) {
        return;
      }
      const container = containerRef.current;
      const gutter = event.target.closest("[data-review-gutter]");
      if (!gutter || !container?.contains(gutter)) {
        return;
      }
      const target = lineTargetFromGutter(gutter);
      if (!target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onLineComment(target);
    },
    [headStale, onLineComment],
  );
  const target = draftComment?.pendingTarget;
  const showComposer = Boolean(composerLayout && target?.path === chunk.file);

  return (
    <div className="relative" onClickCapture={handleChunkClick} ref={containerRef}>
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
      {showComposer
        ? createPortal(
            <div
              className={REVIEW_INLINE_COMPOSER_ANCHOR_CLASS}
              style={{
                left: `${composerLayout.left}px`,
                top: `${composerLayout.top}px`,
                width: `${composerLayout.width}px`,
              }}
            >
              <InlineCommentComposer
                activeEntry={draftComment.activeEntry}
                body={draftComment.body}
                headStale={draftComment.headStale}
                onBodyChange={draftComment.setBody}
                onCancel={draftComment.cancelComposer}
                onSave={draftComment.saveComment}
                target={target}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function syncGutterCommentMarker(gutter, { commentIndex, line, path, side }) {
  const entry = commentIndex?.get(lineKey({ line, path, side }));
  const existing = gutter.querySelector("[data-review-comment-marker]");
  const hasCommentClasses = REVIEW_DIFF_GUTTER_HAS_COMMENT_CLASS.split(/\s+/);

  if (!entry) {
    gutter.classList.remove(...hasCommentClasses);
    existing?.remove();
    return;
  }

  gutter.classList.add(...hasCommentClasses);
  const kind = entry.githubThread ? "github" : "draft";
  const label = entry.githubThread ? "Open GitHub comment thread" : "Open draft comment";
  const githubClasses = REVIEW_LINE_COMMENT_MARKER_GITHUB_CLASS.split(/\s+/);

  if (existing) {
    existing.dataset.thread = kind;
    existing.setAttribute("aria-label", label);
    if (kind === "github") {
      existing.classList.add(...githubClasses);
    } else {
      existing.classList.remove(...githubClasses);
    }
    return;
  }

  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = REVIEW_LINE_COMMENT_MARKER_CLASS;
  if (kind === "github") {
    marker.classList.add(...githubClasses);
  }
  marker.dataset.reviewCommentMarker = "true";
  marker.dataset.thread = kind;
  marker.setAttribute("aria-label", label);
  marker.tabIndex = 0;
  gutter.appendChild(marker);
}

function clearActiveDiffLine(container) {
  if (!container) {
    return;
  }
  const activeClasses = REVIEW_DIFF_GUTTER_ACTIVE_CLASS.split(/\s+/);
  container.querySelectorAll("[data-review-diff-line-active]").forEach((element) => {
    delete element.dataset.reviewDiffLineActive;
    element.querySelectorAll("[data-review-gutter]").forEach((gutter) => {
      gutter.classList.remove(...activeClasses);
    });
  });
}

function measureFixedComposer(row) {
  const rowRect = row.getBoundingClientRect();
  const width = Math.min(
    360,
    Math.max(280, Math.min(rowRect.width || 360, window.innerWidth - 24)),
  );
  const left = Math.min(
    Math.max(12, rowRect.left + 56),
    Math.max(12, window.innerWidth - width - 12),
  );
  const estimatedHeight = 220;
  const below = rowRect.bottom + 8;
  const top =
    below + estimatedHeight > window.innerHeight - 12
      ? Math.max(12, rowRect.top - estimatedHeight - 8)
      : Math.max(12, below);

  return { left, top, width };
}

const root = createRoot(document.getElementById("pr-review-root"));
root.render(<App />);
