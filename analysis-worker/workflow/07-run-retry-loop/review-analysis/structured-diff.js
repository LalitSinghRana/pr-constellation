export function buildStructuredDiff(inventory, { hunkIdsByFileId = null } = {}) {
  return {
    schemaVersion: "pr-structured-diff/v1",
    changedLineCount: inventory?.changedLineCount || 0,
    files: (inventory?.files || [])
      .filter(
        (file) =>
          file.changedLineIds?.length > 0 && (!hunkIdsByFileId || hunkIdsByFileId.has(file.id)),
      )
      .map((file) => {
        const selectedHunkIds = hunkIdsByFileId?.get(file.id);
        return {
          id: file.id,
          path: file.path,
          status: file.status,
          add: file.addedLines ?? 0,
          del: file.deletedLines ?? 0,
          hunks: (file.hunks || [])
            .filter(
              (hunk) =>
                hunk.changedLineIds?.length > 0 &&
                (selectedHunkIds === undefined ||
                  selectedHunkIds === null ||
                  selectedHunkIds.has(hunk.id)),
            )
            .map((hunk) => ({
              id: hunk.id,
              header: hunk.header,
              oldStart: hunk.oldStartLine,
              newStart: hunk.newStartLine,
              lines: (hunk.lines || []).map((line) => ({
                ...(line.kind === "context" ? {} : { id: line.id }),
                kind: line.kind,
                old: line.oldLine,
                new: line.newLine,
                content: line.content,
              })),
            })),
        };
      }),
  };
}

export function materializeLineOwnership(analysis, { inventory }) {
  const inventoryFileById = new Map((inventory?.files || []).map((file) => [file.id, file]));
  const inventoryFileByPath = new Map((inventory?.files || []).map((file) => [file.path, file]));
  const locations = indexChangedLineLocations(inventory);

  return {
    ...analysis,
    files: (analysis?.files || []).map((file) => {
      const inventoryFile = inventoryFileById.get(file.id) || inventoryFileByPath.get(file.path);
      if (!inventoryFile) {
        throw new Error(
          `Cannot materialize line ownership for unknown file ${file.id || file.path || "<missing>"}.`,
        );
      }

      const sections = (file.sectionTree?.sections || []).map((section) => ({
        ...section,
        changedLineIds: expandChangedLineRanges({
          file: inventoryFile,
          locations,
          section,
        }),
      }));
      const coveredIds = new Set(sections.flatMap((section) => section.changedLineIds));

      return {
        ...file,
        changedLineIds: (inventoryFile.changedLineIds || []).filter((lineId) =>
          coveredIds.has(lineId),
        ),
        sectionTree: {
          ...file.sectionTree,
          sections,
        },
      };
    }),
  };
}

function indexChangedLineLocations(inventory) {
  const locations = new Map();

  for (const [fileIndex, file] of (inventory?.files || []).entries()) {
    let fileChangedIndex = 0;
    for (const hunk of file.hunks || []) {
      const changedLineIds = hunk.changedLineIds || [];
      for (const [hunkChangedIndex, lineId] of changedLineIds.entries()) {
        locations.set(lineId, {
          fileId: file.id,
          fileIndex,
          fileChangedIndex,
          hunk,
          hunkChangedIndex,
        });
        fileChangedIndex += 1;
      }
    }
  }

  return locations;
}

function expandChangedLineRanges({ file, locations, section }) {
  if (!Array.isArray(section.changedLineRanges) || section.changedLineRanges.length === 0) {
    throw new Error(`Review section ${section.id || "<missing>"} must include changedLineRanges.`);
  }

  const expanded = [];
  let previousEndIndex = -1;

  for (const range of section.changedLineRanges) {
    const start = locations.get(range?.start);
    const end = locations.get(range?.end);
    if (!start || !end) {
      throw new Error(
        `Review section ${section.id || "<missing>"} contains an unknown changed-line range.`,
      );
    }
    if (
      start.fileId !== file.id ||
      end.fileId !== file.id ||
      start.hunk.id !== end.hunk.id ||
      start.hunkChangedIndex > end.hunkChangedIndex
    ) {
      throw new Error(
        `Review section ${section.id || "<missing>"} ranges must be forward, file-local, and stay within one hunk.`,
      );
    }
    if (start.fileChangedIndex <= previousEndIndex) {
      throw new Error(
        `Review section ${section.id || "<missing>"} ranges must be non-overlapping and in source order.`,
      );
    }

    expanded.push(
      ...start.hunk.changedLineIds.slice(start.hunkChangedIndex, end.hunkChangedIndex + 1),
    );
    previousEndIndex = end.fileChangedIndex;
  }

  return expanded;
}

export function compactLineOwnership(analysis) {
  return {
    ...analysis,
    files: (analysis?.files || []).map(({ changedLineIds, ...file }) => ({
      ...file,
      sectionTree: {
        ...file.sectionTree,
        sections: (file.sectionTree?.sections || []).map(
          ({ changedLineIds: sectionLineIds, ...section }) => section,
        ),
      },
    })),
  };
}
