export function lineTargetFromChunkLine(line, chunk) {
  if (!line || !chunk?.file) {
    return null;
  }

  if (line.type === "del" && line.oldLine != null) {
    return { line: line.oldLine, path: chunk.file, side: "LEFT" };
  }

  if (line.newLine != null) {
    return { line: line.newLine, path: chunk.file, side: "RIGHT" };
  }

  if (line.oldLine != null) {
    return { line: line.oldLine, path: chunk.file, side: "LEFT" };
  }

  return null;
}

export function lineTargetFromGutter(gutter) {
  if (!gutter?.dataset) {
    return null;
  }

  const line = parseGutterLine(gutter.dataset.reviewLine ?? gutter.textContent);
  const side = gutter.dataset.reviewSide;
  const path = gutter.dataset.reviewPath;

  if (!line || !side || !path) {
    return null;
  }

  return { line, path, side };
}

export function resolveClickedLineTarget(_chunk, event) {
  const gutter = event.target.closest("[data-line-old-num], [data-line-new-num]");
  if (!gutter) {
    return null;
  }

  return lineTargetFromGutter(gutter);
}

export function lineKey({ line, path, side }) {
  return `${path}:${side}:${line}`;
}

function parseGutterLine(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
