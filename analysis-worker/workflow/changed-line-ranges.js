function compareBoundary(left, right) {
  if (left.fileIndex !== right.fileIndex) {
    return left.fileIndex - right.fileIndex;
  }
  if (left.hunkIndex !== right.hunkIndex) {
    return left.hunkIndex - right.hunkIndex;
  }
  return left.lineIndex - right.lineIndex;
}

function changedLineIdsInSpan(hunk, startLineIndex, endLineIndex) {
  return (hunk.lines || [])
    .filter(
      (line, lineIndex) =>
        lineIndex >= startLineIndex &&
        lineIndex <= endLineIndex &&
        (line.kind === "insert" || line.kind === "delete"),
    )
    .map((line) => line.id);
}

export function indexHunkLineLocations(inventory) {
  const locations = new Map();

  for (const [fileIndex, file] of (inventory?.files || []).entries()) {
    for (const [hunkIndex, hunk] of (file.hunks || []).entries()) {
      for (const [lineIndex, line] of (hunk.lines || []).entries()) {
        locations.set(line.id, {
          fileId: file.id,
          fileIndex,
          hunk,
          hunkIndex,
          hunkId: hunk.id,
          kind: line.kind,
          lineIndex,
        });
      }
    }
  }

  return locations;
}

function expandRanges({ file, locations, onRangeError, ranges, sectionId }) {
  const expanded = [];
  let previousEnd = null;

  for (const [rangeIndex, range] of ranges.entries()) {
    const start = locations.get(range?.start);
    const end = locations.get(range?.end);

    if (!start || !end) {
      onRangeError({
        message: `Review section ${sectionId} contains an unknown hunk line range.`,
        rangeIndex,
        type: "unknown-boundary",
      });
      continue;
    }
    if (
      start.fileId !== file.id ||
      end.fileId !== file.id ||
      start.hunkId !== end.hunkId ||
      start.lineIndex > end.lineIndex
    ) {
      onRangeError({
        message: `Review section ${sectionId} ranges must be forward, file-local, and stay within one hunk.`,
        rangeIndex,
        type: "invalid-span",
      });
      continue;
    }
    if (previousEnd && compareBoundary(start, previousEnd) <= 0) {
      onRangeError({
        message: `Review section ${sectionId} ranges must be non-overlapping and in source order.`,
        rangeIndex,
        type: "overlap",
      });
      continue;
    }

    expanded.push(...changedLineIdsInSpan(start.hunk, start.lineIndex, end.lineIndex));
    previousEnd = end;
  }

  return expanded;
}

export function expandChangedLineRanges({ file, locations, section }) {
  const sectionId = section.id || "<missing>";
  if (!Array.isArray(section.changedLineRanges) || section.changedLineRanges.length === 0) {
    throw new Error(`Review section ${sectionId} must include changedLineRanges.`);
  }

  return expandRanges({
    file,
    locations,
    onRangeError: ({ message }) => {
      throw new Error(message);
    },
    ranges: section.changedLineRanges,
    sectionId,
  });
}

export function validateSectionChangedLineRanges({
  changedLineIds,
  errors,
  file,
  inventoryFile,
  locations,
  owner,
  section,
}) {
  const ranges = section.changedLineRanges;
  if (!Array.isArray(ranges) || ranges.length === 0) {
    errors.push(
      `analysis.json review section ${owner} must contain at least one changedLineRange.`,
    );
    return;
  }

  const inventoryTarget = inventoryFile || file;
  const expandedIds = expandRanges({
    file: inventoryTarget,
    locations,
    onRangeError: ({ rangeIndex, type }) => {
      if (type === "unknown-boundary") {
        errors.push(
          `analysis.json review section ${owner} changedLineRanges[${rangeIndex}] references an unknown hunk line boundary.`,
        );
        return;
      }
      if (type === "invalid-span") {
        errors.push(
          `analysis.json review section ${owner} changedLineRanges[${rangeIndex}] must be forward and stay within one file hunk.`,
        );
        return;
      }
      errors.push(
        `analysis.json review section ${owner} changedLineRanges must be non-overlapping and in source order.`,
      );
    },
    ranges,
    sectionId: section.id || "<missing>",
  });

  if (
    expandedIds.length !== changedLineIds.length ||
    expandedIds.some((lineId, index) => lineId !== changedLineIds[index])
  ) {
    errors.push(
      `analysis.json review section ${owner} changedLineIds must exactly match its materialized changedLineRanges.`,
    );
  }
}
