import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildChunkDiffData } from "./diff-view-model.js";
import { InlineCommentComposer } from "./inline-comment-composer.jsx";
import { lineKey, lineTargetFromGutter } from "./review-comment-model.js";

const INITIAL_COLOR_MODE = document.documentElement.classList.contains("dark") ? "dark" : "light";
const REVIEW_DIFF_GUTTER_CLASS =
  "cursor-pointer relative select-none hover:bg-primary/12 hover:text-primary";
const REVIEW_DIFF_GUTTER_HAS_COMMENT_CLASS = "text-primary font-bold";
const REVIEW_DIFF_GUTTER_ACTIVE_CLASS = "bg-primary/18 text-primary font-bold";
const REVIEW_LINE_COMMENT_MARKER_CLASS =
  "absolute top-1/2 right-px size-2 border-0 p-0 rounded-full -translate-y-1/2 bg-primary cursor-pointer shadow-[0_0_0_2px_color-mix(in_oklab,var(--card)_80%,transparent)]";
const REVIEW_LINE_COMMENT_MARKER_GITHUB_CLASS = "bg-[color-mix(in_oklab,var(--primary)_55%,white)]";
const REVIEW_INLINE_COMPOSER_ANCHOR_CLASS = "fixed z-[200] pointer-events-auto";

export function UnchangedLinesGap({ nextChunk, prevChunk }) {
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

export function DiffChunkView({ chunk, commentIndex, draftComment, headStale, onLineComment }) {
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
