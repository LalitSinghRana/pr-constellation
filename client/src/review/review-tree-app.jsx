import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";
import { useSettingsQuery } from "../hooks/use-settings.js";
import { EMPTY_SETTINGS } from "../lib/queue.js";
import { PullRequestConversation } from "./pull-request-conversation.jsx";
import { ReviewDraftProvider } from "./review-draft-panel.jsx";
import { ReviewHeader } from "./review-header.jsx";
import { buildReviewTree, sectionTreeSections } from "./review-tree/layout.js";
import { readReviewSlug, usePersistentStringSet } from "./review-tree/state.js";
import { ReviewTreeCanvas } from "./review-tree-canvas.jsx";

function App({ review, reviewSlug, treeData }) {
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
  const settingsQuery = useSettingsQuery();
  const settings = settingsQuery.data ?? EMPTY_SETTINGS;
  const [activeTabOverride, setActiveTabOverride] = useState(null);
  const [reviewerModeOverride, setReviewerModeOverride] = useState(null);
  const activeTab = activeTabOverride ?? settings.defaultReviewTab;
  const reviewerMode = reviewerModeOverride ?? settings.reviewTreeDensity;
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
      foldGroups: reviewerMode !== "10x",
      measuredHeights,
      showSecondaryRuntime: reviewerMode === "1x",
    });
  }, [
    activeStackId,
    expandedGroupIds,
    sourceOrderViewIds,
    measuredHeights,
    reviewerMode,
    treeData,
  ]);
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
    <ReviewDraftProvider reviewSlug={reviewSlug}>
      <div className="review-shell fixed inset-0 grid h-dvh w-screen min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden bg-background">
        <ReviewHeader activeTab={activeTab} onTabChange={setActiveTabOverride} review={review} />
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
                  onActiveStackChange={setActiveStackId}
                  onFileViewModeChange={setFileViewMode}
                  onMeasuredHeightsChange={handleMeasuredHeightsChange}
                  onReviewerModeChange={setReviewerModeOverride}
                  onToggleReviewGroup={toggleReviewGroup}
                  reviewerMode={reviewerMode}
                  stacks={stacks}
                  tree={tree}
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
    </ReviewDraftProvider>
  );
}

export function ReviewTreeApp({ review, reviewSlug, treeData }) {
  return <App review={review} reviewSlug={reviewSlug || readReviewSlug()} treeData={treeData} />;
}
