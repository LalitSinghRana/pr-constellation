import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// @git-diff-view/react needs a real DOM (it defers row rendering until mounted, and
// measures text via canvas) to actually compute and render a diff — the rest of this repo's
// webview checks only inspect bundle/data shape, which would not have caught the bug this
// test guards against: a malformed synthetic hunk that silently produces an empty diff.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.MutationObserver = dom.window.MutationObserver;

dom.window.HTMLCanvasElement.prototype.getContext = () => ({
  measureText: (text) => ({ width: String(text).length * 7 }),
  font: "",
});

class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = FakeObserver;
dom.window.ResizeObserver = FakeObserver;
global.IntersectionObserver = FakeObserver;
dom.window.IntersectionObserver = FakeObserver;

global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { useEffect, useMemo, useRef } = React;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { DiffView, DiffModeEnum } = await import("@git-diff-view/react");

// Mirrors review-tree-app.jsx's buildChunkDiffData/buildLineAstNodes/createPreHighlightedHighlighter,
// since review-tree-app.jsx is a browser JSX entry point (imports library CSS) and isn't importable
// from a plain Node test.
function tokensToAstNodes(tokens) {
  return (tokens || []).map((token) =>
    token.style
      ? {
          children: [{ type: "text", value: token.content }],
          properties: { style: token.style },
          tagName: "span",
          type: "element",
        }
      : { type: "text", value: token.content },
  );
}

function buildLineAstNodes(lines) {
  const children = [];
  lines.forEach((line, index) => {
    children.push(...tokensToAstNodes(line.syntaxTokens));
    if (index < lines.length - 1) {
      children.push({ type: "text", value: "\n" });
    }
  });
  return children;
}

function processPreHighlightedAst(ast) {
  let lineNumber = 1;
  const syntaxObj = {};
  const loopAst = (nodes, wrapper) => {
    nodes.forEach((node) => {
      if (node.type === "text") {
        if (!node.value.includes("\n")) {
          const valueLength = node.value.length;
          if (!syntaxObj[lineNumber]) {
            node.startIndex = 0;
            node.endIndex = valueLength - 1;
            syntaxObj[lineNumber] = {
              lineNumber,
              nodeList: [{ node, wrapper }],
              value: node.value,
              valueLength,
            };
          } else {
            node.startIndex = syntaxObj[lineNumber].valueLength;
            node.endIndex = node.startIndex + valueLength - 1;
            syntaxObj[lineNumber].value += node.value;
            syntaxObj[lineNumber].valueLength += valueLength;
            syntaxObj[lineNumber].nodeList.push({ node, wrapper });
          }
          node.lineNumber = lineNumber;
          return;
        }

        const segments = node.value.split("\n");
        segments.forEach((segment, segmentIndex) => {
          const isLastSegment = segmentIndex === segments.length - 1;
          const segmentValue = isLastSegment ? segment : `${segment}\n`;
          const segmentLineNumber = segmentIndex === 0 ? lineNumber : ++lineNumber;
          const segmentValueLength = segmentValue.length;
          const segmentNode = {
            endIndex: Infinity,
            lineNumber: segmentLineNumber,
            startIndex: Infinity,
            type: "text",
            value: segmentValue,
          };
          if (!syntaxObj[segmentLineNumber]) {
            segmentNode.startIndex = 0;
            segmentNode.endIndex = segmentValueLength - 1;
            syntaxObj[segmentLineNumber] = {
              lineNumber: segmentLineNumber,
              nodeList: [{ node: segmentNode, wrapper }],
              value: segmentValue,
              valueLength: segmentValueLength,
            };
          } else {
            segmentNode.startIndex = syntaxObj[segmentLineNumber].valueLength;
            segmentNode.endIndex = segmentNode.startIndex + segmentValueLength - 1;
            syntaxObj[segmentLineNumber].value += segmentValue;
            syntaxObj[segmentLineNumber].valueLength += segmentValueLength;
            syntaxObj[segmentLineNumber].nodeList.push({ node: segmentNode, wrapper });
          }
        });
        node.lineNumber = lineNumber;
        return;
      }

      if (node.children) {
        loopAst(node.children, node);
        node.lineNumber = lineNumber;
      }
    });
  };
  loopAst(ast.children);
  return { syntaxFileLineNumber: lineNumber, syntaxFileObject: syntaxObj };
}

function createPreHighlightedHighlighter({ newAst, newFileContent, oldAst }) {
  return {
    getAST: (raw) => (raw === newFileContent ? newAst : oldAst),
    hasRegisteredCurrentLang: () => true,
    ignoreSyntaxHighlightList: [],
    maxLineToIgnoreSyntax: Number.POSITIVE_INFINITY,
    name: "pre-highlighted",
    processAST: processPreHighlightedAst,
    setIgnoreSyntaxHighlightList: () => {},
    setMaxLineToIgnoreSyntax: () => {},
    type: "style",
  };
}

function buildChunkDiffData(chunk) {
  const lines = chunk.lines || [];
  const oldLines = lines.filter((line) => line.type !== "add");
  const newLines = lines.filter((line) => line.type !== "del");
  const oldFileContent = oldLines.map((line) => line.content).join("\n");
  const newFileContent = newLines.map((line) => line.content).join("\n");
  const oldStart = oldLines.length > 0 ? 1 : 0;
  const newStart = newLines.length > 0 ? 1 : 0;
  const hunkHeader = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`;
  const hunkBody = lines
    .map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.content}`)
    .join("\n");
  const hunkText = `--- a/${chunk.file}\n+++ b/${chunk.file}\n${hunkHeader}\n${hunkBody}`;

  return {
    data: {
      hunks: [hunkText],
      newFile: { content: newFileContent, fileLang: "plaintext", fileName: chunk.file },
      oldFile: { content: oldFileContent, fileLang: "plaintext", fileName: chunk.file },
    },
    realOldLineNumbers: oldLines.map((line) => line.oldLine),
    realNewLineNumbers: newLines.map((line) => line.newLine),
    registerHighlighter: createPreHighlightedHighlighter({
      newAst: { children: buildLineAstNodes(newLines), type: "root" },
      newFileContent,
      oldAst: { children: buildLineAstNodes(oldLines), type: "root" },
      oldFileContent,
    }),
  };
}

function DiffChunkView({ chunk }) {
  const { data, realNewLineNumbers, realOldLineNumbers, registerHighlighter } = useMemo(
    () => buildChunkDiffData(chunk),
    [chunk],
  );
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    const applyRealLineNumbers = () => {
      container.querySelectorAll("[data-line-old-num]").forEach((el) => {
        const real = realOldLineNumbers[Number(el.getAttribute("data-line-old-num")) - 1];

        if (real != null && el.textContent !== String(real)) {
          el.textContent = String(real);
        }
      });

      container.querySelectorAll("[data-line-new-num]").forEach((el) => {
        const real = realNewLineNumbers[Number(el.getAttribute("data-line-new-num")) - 1];

        if (real != null && el.textContent !== String(real)) {
          el.textContent = String(real);
        }
      });
    };

    applyRealLineNumbers();
    const observer = new MutationObserver(applyRealLineNumbers);
    observer.observe(container, { characterData: true, childList: true, subtree: true });

    return () => observer.disconnect();
  }, [realNewLineNumbers, realOldLineNumbers]);

  return React.createElement(
    "div",
    { ref: containerRef },
    React.createElement(DiffView, {
      className: "review-section-code",
      data,
      diffViewFontSize: 11,
      diffViewHighlight: true,
      diffViewMode: DiffModeEnum.Unified,
      diffViewWrap: false,
      registerHighlighter,
    }),
  );
}

const chunk = {
  file: "config.js",
  lines: [
    {
      content: "    width: 24,",
      oldLine: 82,
      newLine: null,
      syntaxTokens: [{ content: "    width: 24," }],
      type: "del",
    },
    {
      content: "    width: 36,",
      oldLine: null,
      newLine: 69,
      syntaxTokens: [{ content: "    width: 36," }],
      type: "add",
    },
  ],
};

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

await act(async () => {
  root.render(React.createElement(DiffChunkView, { chunk }));
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
});

const html = container.innerHTML;
const oldGutterNumbers = [...container.querySelectorAll("[data-line-old-num]")].map(
  (el) => el.textContent,
);
const newGutterNumbers = [...container.querySelectorAll("[data-line-new-num]")].map(
  (el) => el.textContent,
);
await act(async () => {
  root.unmount();
});

assert.match(
  html,
  /24/,
  "the deleted line's content should render, not collapse into an empty diff",
);
assert.match(html, /36/, "the added line's content should render, not collapse into an empty diff");
assert.match(
  html,
  /data-diff-highlight[^>]*--diff-del-content-highlight--[^>]*>24</,
  "the changed substring on the del line should get the intra-line diff highlight",
);
assert.match(
  html,
  /data-diff-highlight[^>]*--diff-add-content-highlight--[^>]*>36</,
  "the changed substring on the add line should get the intra-line diff highlight",
);
assert.deepEqual(
  oldGutterNumbers,
  ["82"],
  "the old-side gutter should show the real PR line number, not the synthetic 1-based hunk position",
);
assert.deepEqual(
  newGutterNumbers,
  ["69"],
  "the new-side gutter should show the real PR line number, not the synthetic 1-based hunk position",
);

console.log("diff view render checks passed");
