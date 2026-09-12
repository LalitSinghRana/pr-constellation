export const COMMENT_PANEL_WIDTH = 520;
export const COMMENT_PANEL_WIDTH_CLASS = "w-[520px]";
export const CURRENT_REVIEW_NODE_Z_INDEX = 20;

export function measureLineAnchor(row, host, previous = null) {
  const rowRect = row.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const scale = hostRect.height / (host.offsetHeight || hostRect.height) || 1;
  const top = (rowRect.top + (rowRect.height || 0) / 2 - hostRect.top) / scale;
  const next = { top };
  if (previous && Math.abs(previous.top - next.top) <= 1) {
    return previous;
  }
  return next;
}

export function findCommentAnchorRow(container, target) {
  const gutter =
    [...container.querySelectorAll("[data-review-gutter]")].find(
      (element) =>
        element.dataset.reviewLine === String(target.line) &&
        element.dataset.reviewSide === target.side,
    ) || container.querySelector("[data-review-comment-marker]")?.closest("[data-review-gutter]");
  if (!gutter) {
    return null;
  }
  return (
    gutter.closest("[data-review-diff-line]") ||
    gutter.closest("tr") ||
    gutter.closest(".diff-line") ||
    gutter.parentElement
  );
}

export function commentTargetFromKey(key, commentIndex) {
  const entry = commentIndex?.get(key);
  const thread = entry?.githubThread;
  if (thread?.path && thread.line != null) {
    return { line: thread.line, path: thread.path, side: thread.diffSide || "RIGHT" };
  }
  if (entry?.path && entry.line != null) {
    return { line: entry.line, path: entry.path, side: entry.side || "RIGHT" };
  }
  const match = /^([\s\S]+):(LEFT|RIGHT):(\d+)$/.exec(key);
  if (!match) {
    return null;
  }
  return { line: Number(match[3]), path: match[1], side: match[2] };
}

export function chunkContainsLine(chunk, target) {
  if (!chunk?.file || target?.path !== chunk.file || target?.line == null) {
    return false;
  }
  return (chunk.lines || []).some((line) => {
    if (target.side === "LEFT") {
      return line.oldLine === target.line;
    }
    return line.newLine === target.line;
  });
}

export function latestCommentKeyOnSection(
  reviewSection,
  filePath,
  commentIndex,
  excludedKeys = new Set(),
) {
  if (!filePath || !commentIndex?.size) {
    return null;
  }

  let picked = null;
  for (const key of commentIndex.keys()) {
    if (excludedKeys.has(key)) {
      continue;
    }
    const target = commentTargetFromKey(key, commentIndex);
    if (!target || target.path !== filePath || !sectionContainsLine(reviewSection, target)) {
      continue;
    }
    if (!picked || target.line > picked.line) {
      picked = { key, line: target.line };
    }
  }
  return picked?.key ?? null;
}

function sectionContainsLine(reviewSection, target) {
  return (reviewSection?.codeChunks || []).some((chunk) => chunkContainsLine(chunk, target));
}
