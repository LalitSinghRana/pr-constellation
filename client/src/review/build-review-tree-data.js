import { highlightSnippetLines } from "./shiki-highlighter.js";

export function buildReviewTreeData({ analysis, diffInventory, syntaxHighlighter }) {
  if (analysis.schemaVersion !== "pr-review-analysis/v1") {
    throw new Error(`Unsupported review analysis schema: ${analysis.schemaVersion}`);
  }
  if (!diffInventory || typeof diffInventory !== "object") {
    throw new Error("diffInventory is required to build review tree data.");
  }

  const inventoryIndex = indexDiffInventory(diffInventory);
  return {
    schemaVersion: analysis.schemaVersion,
    intent: analysis.intent,
    summary: analysis.summary,
    confidence: analysis.confidence,
    reviewStacks: analysis.reviewStacks,
    files: analysis.files.map((file) => ({
      id: file.id,
      path: file.path,
      reviewPriority: file.reviewPriority,
      changeKind: file.changeKind,
      explanation: file.explanation,
      changedLineIds: file.changedLineIds,
      sourceCodeChunks: buildCodeChunksForFile({ file, inventoryIndex, syntaxHighlighter }),
      sectionTree: {
        branches: file.sectionTree.branches,
        sections: file.sectionTree.sections.map((section) => ({
          ...section,
          codeChunks: buildCodeChunksForReviewSection({
            file,
            inventoryIndex,
            reviewSection: section,
            syntaxHighlighter,
          }),
        })),
      },
    })),
  };
}

export function buildReviewData({ pr }) {
  return {
    additions: pr.additions ?? null,
    authorLogin: pr.author?.login || "",
    authorAvatarUrl: pr.author?.avatarUrl || "",
    baseRefName: pr.baseRefName || "",
    body: pr.body || "",
    changedFiles: pr.changedFiles ?? null,
    createdAt: pr.createdAt || "",
    deletions: pr.deletions ?? null,
    headRefName: pr.headRefName || "",
    number: pr.number ?? null,
    state: pr.state || "",
    title: pr.title || "",
    url: pr.url || "",
  };
}

function buildCodeChunksForReviewSection({
  file,
  inventoryIndex,
  reviewSection,
  syntaxHighlighter,
}) {
  const changedLinesByHunk = new Map();

  for (const changedLineId of reviewSection.changedLineIds || []) {
    const indexedLine = inventoryIndex.lineById.get(changedLineId);

    if (!indexedLine) {
      continue;
    }

    const hunkLines = changedLinesByHunk.get(indexedLine.hunk.id) || [];
    hunkLines.push(indexedLine);
    changedLinesByHunk.set(indexedLine.hunk.id, hunkLines);
  }

  const chunks = [...changedLinesByHunk.values()].flatMap((changedLines) => {
    const sortedLines = changedLines
      .slice()
      .sort((left, right) => left.lineIndex - right.lineIndex);
    const runs = [];
    const allOwnedLineIds = new Set(sortedLines.map((entry) => entry.line.id));

    for (const indexedLine of sortedLines) {
      const currentRun = runs.at(-1);
      const previousLine = currentRun?.at(-1);
      const crossesUnownedChange = previousLine
        ? indexedLine.hunk.lines
            .slice(previousLine.lineIndex + 1, indexedLine.lineIndex)
            .some(
              (line) =>
                (line.kind === "insert" || line.kind === "delete") && !allOwnedLineIds.has(line.id),
            )
        : false;

      if (!previousLine || crossesUnownedChange) {
        runs.push([indexedLine]);
      } else {
        currentRun.push(indexedLine);
      }
    }

    return runs.map((run) => {
      const hunk = run[0].hunk;
      const ownedLineIds = new Set(run.map((entry) => entry.line.id));
      const firstLineIndex = run[0].lineIndex;
      const lastLineIndex = run.at(-1).lineIndex;
      const start = contextBoundary({
        direction: -1,
        hunk,
        ownedLineIds,
        startIndex: firstLineIndex,
      });
      const end =
        contextBoundary({
          direction: 1,
          hunk,
          ownedLineIds,
          startIndex: lastLineIndex,
        }) + 1;
      const lines = hunk.lines.slice(start, end).map((line) => inventoryLineToSnippetLine(line));

      return {
        file: file.path,
        hunk: `${reviewSection.reviewPriority}/${reviewSection.changeKind} · ${reviewSection.title} · ${hunk.header}`.trim(),
        lines: highlightSnippetLines({
          contextLines: hunk.lines.slice(0, start).map((line) => inventoryLineToSnippetLine(line)),
          file: file.path,
          lines,
          syntaxHighlighter,
        }),
      };
    });
  });

  return chunks.sort(
    (left, right) =>
      (left.lines[0].oldLine ?? left.lines[0].newLine) -
      (right.lines[0].oldLine ?? right.lines[0].newLine),
  );
}

function buildCodeChunksForFile({ file, inventoryIndex, syntaxHighlighter }) {
  const inventoryFile = inventoryIndex.fileByPath.get(file.path);

  return (inventoryFile?.hunks || [])
    .filter((hunk) => (hunk.changedLineIds || []).length > 0)
    .map((hunk) => {
      const lines = (hunk.lines || []).map((line) => inventoryLineToSnippetLine(line));

      return {
        file: file.path,
        hunk: hunk.header || "",
        lines: highlightSnippetLines({
          file: file.path,
          lines,
          syntaxHighlighter,
        }),
      };
    });
}

function contextBoundary({ direction, hunk, ownedLineIds, startIndex }) {
  let boundary = startIndex;
  let contextLineCount = 0;

  for (
    let lineIndex = startIndex + direction;
    lineIndex >= 0 && lineIndex < hunk.lines.length && contextLineCount < 2;
    lineIndex += direction
  ) {
    const line = hunk.lines[lineIndex];
    const isChangedLine = line.kind === "insert" || line.kind === "delete";

    if (isChangedLine && !ownedLineIds.has(line.id)) {
      break;
    }

    boundary = lineIndex;
    contextLineCount += 1;
  }

  return boundary;
}

function indexDiffInventory(inventory) {
  const fileByPath = new Map();
  const lineById = new Map();

  for (const file of inventory.files || []) {
    fileByPath.set(file.path, file);

    for (const hunk of file.hunks || []) {
      (hunk.lines || []).forEach((line, lineIndex) => {
        lineById.set(line.id, {
          file,
          hunk,
          line,
          lineIndex,
        });
      });
    }
  }

  return { fileByPath, lineById };
}

function inventoryLineToSnippetLine(line) {
  return {
    content: line.content,
    hunkId: line.hunkId,
    id: line.id,
    newLine: line.newLine,
    oldLine: line.oldLine,
    prefix: line.prefix,
    type: line.kind === "insert" ? "add" : line.kind === "delete" ? "del" : "context",
  };
}
