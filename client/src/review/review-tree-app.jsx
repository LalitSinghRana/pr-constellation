import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useState } from "react";
import { useSettingsQuery } from "../hooks/use-settings.js";
import { EMPTY_SETTINGS } from "../lib/queue.js";
import { PullRequestConversation } from "./pull-request-conversation.jsx";
import { ReviewDraftProvider } from "./review-draft-panel.jsx";
import { ReviewHeader } from "./review-header.jsx";
import {
  buildReviewTree,
  sectionMaxHeightFromCanvas,
  sectionTreeSections,
} from "./review-tree/layout.js";
import {
  readReviewSlug,
  resolveActiveStackId,
  resolveFileViewMode,
  usePersistentFileViewModeOverrides,
  usePersistentStringSet,
} from "./review-tree/state.js";
import { ReviewTreeCanvas } from "./review-tree-canvas.jsx";
import { ReviewTreesStatus } from "./review-trees-status.jsx";

function App({ analysisBusy, analysisStatus, onAnalyze, review, reviewSlug, treeData }) {
  const hasTree = Boolean(
    (treeData?.files || []).some((file) => sectionTreeSections(file).length > 0),
  );
  const expansionStorageKey = `pr-review-tree-expansion:${window.location.pathname}`;
  const fileViewModeStorageKey = `pr-review-source-view:${window.location.pathname}`;
  const [expandedGroupIds, setExpandedGroupIds] = usePersistentStringSet(expansionStorageKey);
  const [fileViewModeOverrides, setFileViewModeOverrides] =
    usePersistentFileViewModeOverrides(fileViewModeStorageKey);
  const stacks = treeData?.reviewStacks || [];
  const [selectedStackId, setSelectedStackId] = useState(null);
  const activeStackId = resolveActiveStackId(stacks, selectedStackId);
  const settingsQuery = useSettingsQuery();
  const settings = settingsQuery.data ?? EMPTY_SETTINGS;
  const [activeTabOverride, setActiveTabOverride] = useState(null);
  const [reviewerModeOverride, setReviewerModeOverride] = useState(null);
  const activeTab = activeTabOverride ?? settings.defaultReviewTab;
  const reviewerMode = reviewerModeOverride ?? settings.reviewTreeDensity;
  const [canvasHeight, setCanvasHeight] = useState(0);
  const handleCanvasSizeChange = useCallback(({ height }) => {
    setCanvasHeight((current) => (current === height ? current : height));
  }, []);
  const defaultFileViewMode = settings.defaultFileViewMode === "source" ? "source" : "tree";
  const sourceOrderViewIds = new Set(
    (treeData?.files || [])
      .filter(
        (file) =>
          resolveFileViewMode(file.id, fileViewModeOverrides, defaultFileViewMode) === "source",
      )
      .map((file) => file.id),
  );
  const tree = buildReviewTree(treeData, {
    activeStackId,
    expandedGroupIds,
    sourceOrderViewIds,
    foldGroups: reviewerMode !== "10x",
    sectionMaxHeight: sectionMaxHeightFromCanvas(canvasHeight),
    showSecondaryRuntime: reviewerMode === "1x",
  });
  function toggleReviewGroup(groupId) {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }
  function setFileViewMode(fileId, viewMode) {
    const nextMode = viewMode === "source" ? "source" : "tree";
    setFileViewModeOverrides((current) => {
      const next = new Map(current);
      next.set(fileId, nextMode);
      return next;
    });
  }

  return (
    <ReviewDraftProvider reviewSlug={reviewSlug}>
      <div className="review-shell fixed inset-0 grid h-dvh w-screen min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden bg-background">
        <ReviewHeader activeTab={activeTab} onTabChange={setActiveTabOverride} review={review} />
        <main className="grid min-h-0 overflow-hidden">
          {activeTab === "conversation" ? (
            <PullRequestConversation review={review} reviewSlug={reviewSlug} />
          ) : hasTree ? (
            <section
              className="size-full min-h-0 overflow-hidden rounded-none border-0 bg-card shadow-none"
              aria-label="PR review tree"
            >
              <ReactFlowProvider>
                <ReviewTreeCanvas
                  activeStackId={activeStackId}
                  onActiveStackChange={setSelectedStackId}
                  onCanvasSizeChange={handleCanvasSizeChange}
                  onFileViewModeChange={setFileViewMode}
                  onReviewerModeChange={setReviewerModeOverride}
                  onToggleReviewGroup={toggleReviewGroup}
                  reviewerMode={reviewerMode}
                  stacks={stacks}
                  tree={tree}
                />
              </ReactFlowProvider>
            </section>
          ) : (
            <ReviewTreesStatus
              analysisBusy={analysisBusy}
              onAnalyze={onAnalyze}
              status={analysisStatus || "not_started"}
            />
          )}
        </main>
      </div>
    </ReviewDraftProvider>
  );
}

export function ReviewTreeApp({
  analysisBusy = false,
  analysisStatus,
  onAnalyze,
  review,
  reviewSlug,
  treeData,
}) {
  return (
    <App
      analysisBusy={analysisBusy}
      analysisStatus={analysisStatus}
      onAnalyze={onAnalyze}
      review={review}
      reviewSlug={reviewSlug || readReviewSlug()}
      treeData={treeData}
    />
  );
}
