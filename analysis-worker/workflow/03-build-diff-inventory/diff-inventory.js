import diff2html from "diff2html";

export function createDiffInventory(diff) {
  const files = diff2html.parse(diff);
  const inventoryFiles = [];
  const changedLines = [];

  files.forEach((file, fileIndex) => {
    const fileId = `file-${fileIndex + 1}`;
    const path = normalizeFilePath(file);
    const hunks = [];
    const fileChangedLineIds = [];

    (file.blocks || []).forEach((block, blockIndex) => {
      const hunkId = `${fileId}:hunk-${blockIndex + 1}`;
      const lines = [];

      (block.lines || []).forEach((line, lineIndex) => {
        const kind = inventoryLineKind(line.type);
        const lineId = `${hunkId}:line-${lineIndex + 1}`;
        const inventoryLine = {
          id: lineId,
          content: stripDiffPrefix(line.content),
          hunkId,
          kind,
          newLine: line.newNumber ?? null,
          oldLine: line.oldNumber ?? null,
          prefix: diffLinePrefix(kind),
        };

        lines.push(inventoryLine);

        if (kind === "insert" || kind === "delete") {
          const changedLine = {
            ...inventoryLine,
            file: path,
          };

          changedLines.push(changedLine);
          fileChangedLineIds.push(lineId);
        }
      });

      hunks.push({
        id: hunkId,
        changedLineIds: lines
          .filter((line) => line.kind === "insert" || line.kind === "delete")
          .map((line) => line.id),
        header: block.header || "",
        lines,
        newStartLine: block.newStartLine ?? null,
        oldStartLine: block.oldStartLine ?? null,
      });
    });

    inventoryFiles.push({
      id: fileId,
      addedLines: file.addedLines ?? 0,
      changedLineIds: fileChangedLineIds,
      deletedLines: file.deletedLines ?? 0,
      hunks,
      language: file.language || "",
      newPath: file.newName || "",
      oldPath: file.oldName || "",
      path,
      status: inferFileStatus(file),
    });
  });

  return {
    schemaVersion: "diff-inventory/v1",
    changedLineCount: changedLines.length,
    changedLines,
    files: inventoryFiles,
  };
}

export function createDiffSummary(inventory) {
  return {
    schemaVersion: "diff-summary/v1",
    changedLineCount: inventory?.changedLineCount || 0,
    files: (inventory?.files || [])
      .filter((file) => file.changedLineIds?.length > 0)
      .map((file) => ({
        id: file.id,
        add: file.addedLines ?? 0,
        del: file.deletedLines ?? 0,
        path: file.path,
        status: file.status,
        hunks: (file.hunks || [])
          .filter((hunk) => hunk.changedLineIds?.length > 0)
          .map((hunk) => ({
            id: hunk.id,
            header: hunk.header,
            lines: (hunk.lines || [])
              .filter((line) => line.kind === "insert" || line.kind === "delete")
              .map((line) => ({
                id: line.id,
                kind: line.kind === "insert" ? "add" : "del",
                new: line.newLine,
                old: line.oldLine,
                text: previewLineContent(line.content),
                truncated: String(line.content || "").length > 100,
              })),
          })),
      })),
  };
}

function normalizeFilePath(file) {
  if (file.newName && file.newName !== "/dev/null") {
    return file.newName;
  }

  return file.oldName || "";
}

function inferFileStatus(file) {
  if (file.isNew) {
    return "added";
  }

  if (file.isDeleted) {
    return "deleted";
  }

  if (file.oldName && file.newName && file.oldName !== file.newName) {
    return "renamed";
  }

  return "modified";
}

function inventoryLineKind(type) {
  if (type === "insert") {
    return "insert";
  }

  if (type === "delete") {
    return "delete";
  }

  return "context";
}

function diffLinePrefix(kind) {
  if (kind === "insert") {
    return "+";
  }

  if (kind === "delete") {
    return "-";
  }

  return " ";
}

function stripDiffPrefix(content) {
  const value = String(content ?? "");

  if (value.startsWith("+") || value.startsWith("-") || value.startsWith(" ")) {
    return value.slice(1);
  }

  return value;
}

function previewLineContent(content) {
  const value = String(content ?? "");

  if (value.length <= 100) {
    return value;
  }

  return `${value.slice(0, 97)}...`;
}
