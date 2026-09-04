import { expandChangedLineRanges, indexHunkLineLocations } from "../../changed-line-ranges.js";

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
                id: line.id,
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
  const locations = indexHunkLineLocations(inventory);

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
