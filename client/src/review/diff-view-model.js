export function buildChunkDiffData(chunk) {
  const lines = chunk.lines || [];
  const oldLines = lines.filter((line) => line.type !== "add");
  const newLines = lines.filter((line) => line.type !== "del");
  const oldFileContent = oldLines.map((line) => line.content).join("\n");
  const newFileContent = newLines.map((line) => line.content).join("\n");
  // oldFile/newFile.content IS the whole synthetic "file" handed to the library, so the
  // hunk must claim to start at line 1 on each side (its own line count), not the real PR
  // line number — the library indexes hunk positions against the given content's own
  // length, and a real (larger) line number here makes it fall back to an empty diff.
  const oldStart = oldLines.length > 0 ? 1 : 0;
  const newStart = newLines.length > 0 ? 1 : 0;
  const hunkHeader = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`;
  const hunkBody = lines
    .map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.content}`)
    .join("\n");
  // The parser also looks for a "--- a/... \n+++ b/..." file header before it will read any
  // "@@ ... @@" hunks; without it every hunk is silently discarded as an empty diff.
  const hunkText = `--- a/${chunk.file}\n+++ b/${chunk.file}\n${hunkHeader}\n${hunkBody}`;

  return {
    data: {
      hunks: [hunkText],
      newFile: { content: newFileContent, fileLang: "plaintext", fileName: chunk.file },
      oldFile: { content: oldFileContent, fileLang: "plaintext", fileName: chunk.file },
    },
    // The library numbers its gutter from the synthetic 1-based hunk above; these are the
    // real PR line numbers for the same positions, used to patch the gutter after render.
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

function tokensToAstNodes(tokens) {
  return (tokens || []).map((token) =>
    token.style
      ? {
          children: [{ type: "text", value: token.content }],
          properties: { className: ["shiki-token"], style: token.style },
          tagName: "span",
          type: "element",
        }
      : { type: "text", value: token.content },
  );
}

// The shiki tokens are highlighted server-side (render.js); this highlighter just hands
// pre-built per-file ASTs back to @git-diff-view/react instead of running a highlighter
// engine (e.g. lowlight) in the browser.
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

// Splits a per-file AST (built by buildLineAstNodes) into per-line syntax records.
// Adapted from @git-diff-view/lowlight's processAST: line breaks are detected purely
// from literal "\n" characters inside text node values, not from AST node boundaries.
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
