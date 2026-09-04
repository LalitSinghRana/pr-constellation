import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  COMMENT_PANEL_WIDTH_CLASS,
  chunkContainsLine,
  commentTargetFromKey,
  findCommentAnchorRow,
  measureLineAnchor,
} from "./comment-layout.js";
import { buildChunkDiffData } from "./diff-view-model.js";
import { InlineCommentComposer } from "./inline-comment-composer.jsx";
import { lineKey, lineTargetFromGutter } from "./review-comment-model.js";
import { useReviewDraft } from "./review-draft-panel.jsx";
import { useColorMode } from "./use-color-mode.js";

const REVIEW_DIFF_GUTTER_CLASS =
  "cursor-pointer relative select-none hover:bg-primary/12 hover:text-primary";
const REVIEW_DIFF_GUTTER_HAS_COMMENT_CLASS = "text-primary font-bold";
const REVIEW_DIFF_GUTTER_ACTIVE_CLASS = "bg-primary/18 text-primary font-bold";
const REVIEW_LINE_COMMENT_MARKER_CLASS =
  "absolute top-1/2 right-px size-3.5 border-0 p-0 rounded-full -translate-y-1/2 bg-primary cursor-pointer shadow-[0_0_0_2px_color-mix(in_oklab,var(--card)_80%,transparent)]";
const REVIEW_LINE_COMMENT_MARKER_GITHUB_CLASS = "bg-[color-mix(in_oklab,var(--primary)_55%,white)]";
const REVIEW_INLINE_COMPOSER_ANCHOR_CLASS = `nodrag nopan pointer-events-auto absolute right-full z-20 mr-3 max-h-80 -translate-y-1/2 ${COMMENT_PANEL_WIDTH_CLASS}`;

export function UnchangedLinesGap({ nextChunk, prevChunk }) {
  const gap = unchangedLineGap(prevChunk, nextChunk);

  if (!gap) {
    return null;
  }

  return (
    <div className="border-y border-border bg-[color-mix(in_oklab,var(--muted)_45%,var(--card))] px-2.5 py-[3px] text-[10px] font-semibold tracking-[0.02em] text-muted-foreground">
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

export function DiffChunkView({ chunk }) {
  const colorMode = useColorMode();
  const { commentIndex, headStale, openComposer, openThreadKeys, pendingTarget } = useReviewDraft();
  const { data, realNewLineNumbers, realOldLineNumbers, registerHighlighter } =
    buildChunkDiffData(chunk);
  const containerRef = useRef(null);
  const layoutsRef = useRef(new Map());
  const [composerAnchors, setComposerAnchors] = useState(() => new Map());
  const visibleTargets = commentTargetsForChunk(chunk, commentIndex, openThreadKeys, pendingTarget);

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

            const marker = syncGutterCommentMarker(el, {
              commentIndex,
              line: real,
              path: chunk.file,
              side,
            });
            if (marker) {
              marker.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                const target = lineTargetFromGutter(el);
                if (target) {
                  openComposer(target);
                }
              };
            }
          });
        };

        decorateSide("data-line-old-num", "LEFT", realOldLineNumbers);
        decorateSide("data-line-new-num", "RIGHT", realNewLineNumbers);
      } catch (error) {
        decorating = false;
        throw error;
      }
      decorating = false;
    };

    decorateGutters();
    const openLineCommentFromEvent = (event) => {
      if (headStale || !openComposer) {
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
      openComposer(target);
    };
    container.addEventListener("click", openLineCommentFromEvent, { signal: abort.signal });
    const observer = new MutationObserver(decorateGutters);
    observer.observe(container, { characterData: true, childList: true, subtree: true });

    return () => {
      abort.abort();
      observer.disconnect();
    };
  }, [chunk.file, commentIndex, headStale, openComposer, realNewLineNumbers, realOldLineNumbers]);

  useEffect(() => {
    const container = containerRef.current;
    const host = container?.closest(".react-flow__node");

    if (!container || !host || visibleTargets.length === 0) {
      clearActiveDiffLine(container);
      layoutsRef.current = new Map();
      setComposerAnchors(new Map());
      return undefined;
    }

    let frame = 0;
    let attempts = 0;
    const syncComposerAnchors = () => {
      const next = new Map();
      clearActiveDiffLine(container);
      for (const target of visibleTargets) {
        const row = findCommentAnchorRow(container, target);
        if (!row) {
          continue;
        }

        if (pendingTarget && lineKey(pendingTarget) === lineKey(target)) {
          row.dataset.reviewDiffLineActive = "true";
          row.querySelectorAll("[data-review-gutter]").forEach((activeGutter) => {
            activeGutter.classList.add(...REVIEW_DIFF_GUTTER_ACTIVE_CLASS.split(/\s+/));
          });
        }
        const key = lineKey(target);
        const previous = layoutsRef.current.get(key);
        next.set(key, {
          host,
          top: measureLineAnchor(row, host, previous)?.top,
        });
      }

      if (!anchorsEqual(layoutsRef.current, next)) {
        layoutsRef.current = next;
        setComposerAnchors(next);
      }
      return next.size === visibleTargets.length;
    };

    const waitForRows = () => {
      if (syncComposerAnchors() || attempts >= 30) {
        return;
      }
      attempts += 1;
      frame = window.requestAnimationFrame(waitForRows);
    };
    waitForRows();
    const observer = new MutationObserver(() => {
      syncComposerAnchors();
    });
    observer.observe(container, { childList: true, subtree: true });
    observer.observe(host, { childList: true });
    const resize = new ResizeObserver(() => {
      syncComposerAnchors();
    });
    resize.observe(host);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      clearActiveDiffLine(container);
    };
  }, [pendingTarget, visibleTargets]);

  function handleChunkClick(event) {
    if (headStale || !openComposer) {
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
    openComposer(target);
  }

  return (
    <div className="relative" onClickCapture={handleChunkClick} ref={containerRef}>
      <DiffView
        className="m-0 w-max min-w-full max-w-none overflow-visible"
        data={data}
        diffViewFontSize={11}
        diffViewHighlight
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme={colorMode}
        diffViewWrap={false}
        registerHighlighter={registerHighlighter}
      />
      {visibleTargets.map((target) => {
        const anchor = composerAnchors.get(lineKey(target));
        if (!anchor?.host) {
          return null;
        }
        return createPortal(
          <div
            className={REVIEW_INLINE_COMPOSER_ANCHOR_CLASS}
            data-review-comment-anchor={lineKey(target)}
            key={lineKey(target)}
            style={{ top: `${anchor.top}px` }}
          >
            <InlineCommentComposer target={target} />
          </div>,
          anchor.host,
        );
      })}
    </div>
  );
}

function commentTargetsForChunk(chunk, commentIndex, openThreadKeys, pendingTarget) {
  const targets = [];
  const seen = new Set();
  for (const key of openThreadKeys) {
    const target = commentTargetFromKey(key, commentIndex);
    if (!target || !chunkContainsLine(chunk, target) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push(target);
  }
  if (
    pendingTarget &&
    chunkContainsLine(chunk, pendingTarget) &&
    !seen.has(lineKey(pendingTarget))
  ) {
    targets.push(pendingTarget);
  }
  return targets;
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
    return existing;
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
  return marker;
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

function anchorsEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of right) {
    const current = left.get(key);
    if (!current || current.host !== value.host || Math.abs(current.top - value.top) > 1) {
      return false;
    }
  }
  return true;
}
