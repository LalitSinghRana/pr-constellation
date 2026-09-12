import { BaseEdge, getSmoothStepPath, Handle, Position } from "@xyflow/react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileDiff,
  FolderTree,
  GitBranch,
} from "lucide-react";
import React, { useEffect, useRef } from "react";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Collapsible, CollapsibleTrigger } from "../components/ui/collapsible.jsx";
import { MiddleEllipsis } from "../components/ui/middle-ellipsis/index.js";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.jsx";
import { cn } from "../lib/utils.js";
import { DiffChunkView, UnchangedLinesGap } from "./diff-chunk-view.jsx";
import { ExplanationHoverCard, plainTextExplanation } from "./explanation-hover-card.jsx";
import { FILE_TREE_SOURCE_HANDLE, FILE_TREE_TARGET_HANDLE } from "./review-tree/layout.js";
import { bindWheelScrollPassthrough } from "./wheel-event.js";

const NODE_HANDLE_CLASS = "size-px border-0 bg-transparent opacity-0";

// React Flow needs these types to stay stable across re-renders.
export const nodeTypes = {
  reviewGroup: React.memo(ReviewGroupNode),
  fileNode: React.memo(FileNode),
  reviewSection: React.memo(ReviewSectionNode),
};
export const edgeTypes = {
  reviewBranch: React.memo(ReviewBranch),
};

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
        className={NODE_HANDLE_CLASS}
        id={FILE_TREE_TARGET_HANDLE}
        position={Position.Top}
        type="target"
      />
      <Handle
        className={NODE_HANDLE_CLASS}
        id={FILE_TREE_SOURCE_HANDLE}
        position={Position.Bottom}
        type="source"
      />
      <div className="absolute top-[11px] right-3.5 left-3.5 flex min-w-0 items-center gap-12">
        <div className="relative min-w-0 flex-[3]">
          <ExplanationHoverCard explanation={fileExplanation} side="bottom">
            <Badge
              className="max-w-full min-w-0 justify-start gap-2 overflow-hidden px-2.5 py-2 font-mono text-[13px] leading-none font-bold tracking-normal text-primary select-none data-[has-explanation=true]:pointer-events-auto data-[has-explanation=true]:cursor-help"
              data-has-explanation={Boolean(fileExplanation)}
              tabIndex={fileExplanation ? 0 : undefined}
              variant="outline"
            >
              <FileCode2 aria-hidden="true" className="shrink-0" size={16} />
              <MiddleEllipsis.Span
                className="min-w-0 flex-1"
                title={fileExplanation ? undefined : filePath}
              >
                {filePath}
              </MiddleEllipsis.Span>
            </Badge>
          </ExplanationHoverCard>
        </div>
        <div className="flex min-w-0 flex-[1] justify-end">
          <Tabs
            className="nodrag nopan pointer-events-auto shrink-0 gap-0 select-none"
            onValueChange={(nextMode) => data.onFileViewModeChange?.(data.file.id, nextMode)}
            value={viewMode}
          >
            <TabsList aria-label={`${filePath} view`} className="w-[136px]">
              <TabsTrigger className="text-[11px]" value="tree">
                <GitBranch aria-hidden="true" size={14} />
                Tree
              </TabsTrigger>
              <TabsTrigger className="text-[11px]" value="source">
                <FileDiff aria-hidden="true" size={14} />
                Source
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
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
            "nodrag nopan size-full overflow-hidden rounded-md border border-border bg-card shadow-sm",
            reviewPriority === "primary" &&
              "border-[color-mix(in_oklab,var(--error)_46%,var(--border))] bg-[color-mix(in_oklab,var(--error)_6%,var(--card))]",
            reviewPriority === "secondary" &&
              "border-[color-mix(in_oklab,var(--warning)_46%,var(--border))] bg-[color-mix(in_oklab,var(--warning)_6%,var(--card))]",
            reviewPriority === "skim" &&
              "border-[color-mix(in_oklab,var(--muted-foreground)_34%,var(--border))] bg-[color-mix(in_oklab,var(--muted)_46%,var(--card))]",
          )}
        >
          <Handle className={NODE_HANDLE_CLASS} position={Position.Top} type="target" />
          <CollapsibleTrigger asChild>
            <Button
              aria-label={`${action} ${data.reviewSection.title}`}
              className="grid size-full cursor-pointer grid-cols-[44px_minmax(0,1fr)_28px] items-center gap-3 border-0 bg-transparent px-4 py-3.5 text-left font-[inherit] tracking-normal text-foreground"
              type="button"
              variant="ghost"
            >
              <span
                className={cn(
                  "grid size-[42px] place-items-center rounded-sm border border-[color-mix(in_oklab,currentColor_18%,var(--border))] bg-muted text-error-strong",
                  reviewPriority === "secondary" && "text-warning-strong",
                  reviewPriority === "skim" && "text-muted-foreground",
                )}
              >
                <FolderTree aria-hidden="true" size={20} />
              </span>
              <span className="grid min-w-0 gap-[5px]">
                <span className="truncate text-sm leading-[1.1] font-extrabold">
                  {data.reviewSection.title}
                </span>
                <span className="truncate font-mono text-[11px] leading-[1.15] font-semibold tracking-normal text-muted-foreground">
                  {`${group.branchCount} ${group.branchCount === 1 ? "branch" : "branches"} · ${group.sectionCount} sections · ${group.lineCount} changed lines`}
                </span>
                <span className="truncate text-[11px] leading-[1.15] tracking-normal text-muted-foreground">
                  {rootPreview}
                </span>
              </span>
              <span className="grid size-7 place-items-center rounded-sm text-muted-foreground">
                {group.expanded ? (
                  <ChevronDown aria-hidden="true" size={19} />
                ) : (
                  <ChevronRight aria-hidden="true" size={19} />
                )}
              </span>
            </Button>
          </CollapsibleTrigger>
          <Handle className={NODE_HANDLE_CLASS} position={Position.Bottom} type="source" />
        </article>
      </Collapsible>
    </ExplanationHoverCard>
  );
}

function ReviewSection({ children, className, ...props }) {
  return (
    <article
      className={cn(
        "review-section-node has-[.review-section-header[data-state=open]]:border-ring has-[.review-section-header[data-state=open]]:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_30%,transparent)] has-[.review-section-header:focus-visible]:border-ring has-[.review-section-header:focus-visible]:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_30%,transparent)]",
        className,
      )}
      {...props}
    >
      {children}
    </article>
  );
}

function ReviewSectionHeader({ children, className, reviewPriority, ...props }) {
  return (
    <header
      className={cn(
        "review-section-header flex h-[42px] w-full min-w-0 items-center overflow-hidden border-b border-border bg-muted px-3 text-xs leading-none text-card-foreground outline-none data-[slot=hover-card-trigger]:cursor-help focus-visible:shadow-[inset_0_0_0_3px_color-mix(in_oklab,var(--ring)_30%,transparent)]",
        reviewPriority === "primary" && "bg-[color-mix(in_oklab,var(--error)_9%,var(--muted))]",
        reviewPriority === "secondary" && "bg-[color-mix(in_oklab,var(--warning)_9%,var(--muted))]",
        className,
      )}
      {...props}
    >
      {children}
    </header>
  );
}

function reviewSectionScrollers(body) {
  if (!body) {
    return [];
  }

  const diffScroller = body.querySelector(".diff-table-scroll-container");
  return diffScroller ? [diffScroller, body] : [body];
}

function ReviewSectionBody({ children }) {
  const bodyRef = useRef(null);

  useEffect(
    () =>
      bindWheelScrollPassthrough(
        () => reviewSectionScrollers(bodyRef.current),
        () => bodyRef.current,
      ),
    [],
  );

  return (
    <div
      className="min-h-0 flex-1 overflow-x-auto overflow-y-auto overscroll-contain"
      ref={bodyRef}
    >
      {children}
    </div>
  );
}

ReviewSection.Header = ReviewSectionHeader;
ReviewSection.Body = ReviewSectionBody;

function ReviewSectionNode({ data }) {
  const filePath = data.file?.path || "Unknown file";
  const reviewPriority = data.reviewSection.reviewPriority || "unknown";
  const sourceOrderView = data.reviewSection.sourceOrderView;
  const sectionExplanation = data.reviewSection.explanation || "";

  return (
    <ReviewSection
      aria-label={`Review section for ${filePath}: ${data.reviewSection.title}. ${plainTextExplanation(sectionExplanation)}`}
      className={cn(
        "nodrag nopan flex h-full min-h-0 w-full max-w-full flex-col cursor-text overflow-hidden rounded-md border border-border bg-card shadow-sm select-text",
        reviewPriority === "primary" &&
          "border-[color-mix(in_oklab,var(--error)_46%,var(--border))]",
        reviewPriority === "secondary" &&
          "border-[color-mix(in_oklab,var(--warning)_46%,var(--border))]",
        reviewPriority === "skim" &&
          "border-[color-mix(in_oklab,var(--muted-foreground)_34%,var(--border))]",
      )}
      data-file-path={filePath}
    >
      {sourceOrderView ? null : (
        <Handle className={NODE_HANDLE_CLASS} position={Position.Top} type="target" />
      )}
      <ExplanationHoverCard explanation={sectionExplanation}>
        <ReviewSection.Header
          reviewPriority={reviewPriority}
          tabIndex={sectionExplanation ? 0 : undefined}
        >
          <span className="min-w-0 truncate text-xs font-bold tracking-normal">
            {data.reviewSection.title}
          </span>
        </ReviewSection.Header>
      </ExplanationHoverCard>
      <ReviewSection.Body>
        {(data.reviewSection.codeChunks || []).map((chunk, chunkIndex, chunks) => (
          <React.Fragment
            key={`${data.reviewSection.id}-${chunk.lines[0]?.id}-${chunk.lines.at(-1)?.id}`}
          >
            <UnchangedLinesGap nextChunk={chunk} prevChunk={chunks[chunkIndex - 1]} />
            <DiffChunkView chunk={chunk} />
          </React.Fragment>
        ))}
      </ReviewSection.Body>
      {sourceOrderView ? null : (
        <Handle className={NODE_HANDLE_CLASS} position={Position.Bottom} type="source" />
      )}
    </ReviewSection>
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
  const summary = `${sourceTitle} to ${targetTitle}. ${plainTextExplanation(explanation)}`.trim();

  return (
    <ExplanationHoverCard explanation={explanation} side="top">
      <a
        aria-label={summary}
        className="review-branch-trigger cursor-help outline-none"
        href={`#${id}`}
        onClick={(event) => event.preventDefault()}
      >
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
