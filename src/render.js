import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import diff2html from "diff2html";
import esbuild from "esbuild";
import postcss from "postcss";
import { createHighlighter } from "shiki";
import { createDiffInventory } from "../workflows/pr-graph-analysis/03-build-diff-inventory/diff-inventory.js";

const require = createRequire(import.meta.url);
const ANALYSIS_SCHEMA_PATH = fileURLToPath(new URL("../workflows/pr-graph-analysis/04-generate-candidate-analysis/02-create-mini-trees/schema.json", import.meta.url));
const GRAPH_APP_ENTRY = fileURLToPath(new URL("./web/graph-app.jsx", import.meta.url));
const JSON_VIEW_CSS_PATH = require.resolve("react-json-view-lite/dist/index.css");
const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const WEB_STYLES_ENTRY = fileURLToPath(new URL("./web/styles.css", import.meta.url));
const SHIKI_THEMES = { light: "light-plus", dark: "dark-plus" };
const SHIKI_LANGUAGES = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "java",
  "javascript",
  "jsx",
  "json",
  "kotlin",
  "markdown",
  "php",
  "python",
  "ruby",
  "rust",
  "scss",
  "shellscript",
  "sql",
  "swift",
  "tsx",
  "typescript",
  "xml",
  "yaml",
];
const SHIKI_LANGUAGE_SET = new Set(SHIKI_LANGUAGES);
const LANGUAGE_BY_EXTENSION = new Map([
  ["bash", "bash"],
  ["cjs", "javascript"],
  ["css", "css"],
  ["go", "go"],
  ["html", "html"],
  ["java", "java"],
  ["js", "javascript"],
  ["jsx", "jsx"],
  ["json", "json"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["md", "markdown"],
  ["mjs", "javascript"],
  ["php", "php"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["scss", "scss"],
  ["sh", "shellscript"],
  ["sql", "sql"],
  ["swift", "swift"],
  ["ts", "typescript"],
  ["tsx", "tsx"],
  ["xml", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
]);
const SHIKI_LANGUAGE_ALIASES = new Map([
  ["js", "javascript"],
  ["jsx", "jsx"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["md", "markdown"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["sh", "shellscript"],
  ["ts", "typescript"],
  ["yml", "yaml"],
]);
let graphAssetsPromise;
let syntaxHighlighterPromise;

export async function renderDiffHtml({ analysis = null, pr, diff }) {
  const rawDiffHtml = diff2html.html(diff, {
    drawFileList: true,
    matching: "lines",
    outputFormat: "side-by-side",
    renderNothingWhenEmpty: false,
    synchronisedScroll: true,
  });

  const diff2htmlCss = await readFile(require.resolve("diff2html/bundles/css/diff2html.min.css"), "utf8");
  const analysisSchema = JSON.parse(await readFile(ANALYSIS_SCHEMA_PATH, "utf8"));
  const syntaxHighlighter = await getSyntaxHighlighter();
  const diffHtml = highlightDiffHtml({ diffHtml: rawDiffHtml, syntaxHighlighter });
  const graphAssets = await getGraphAssets();
  const graphData = analysis ? buildGraphData({ analysis, diff, syntaxHighlighter }) : null;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(pr.title)} · PR #${escapeHtml(String(pr.number))}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <style>
${diff2htmlCss}
${graphAssets?.css || ""}
    </style>
  </head>
  <body>
    <div id="pr-review-root"></div>
    <script id="pr-review-data" type="application/json">${serializeJsonForScript(buildReviewData({ graphData, pr }))}</script>
    <script id="pr-analysis-schema" type="application/json">${serializeJsonForScript(analysisSchema)}</script>
    <script id="pr-analysis-output" type="application/json">${serializeJsonForScript(analysis)}</script>
    <script id="pr-analysis-data" type="application/json">${serializeJsonForScript(graphData)}</script>
    <script id="pr-diff-html" type="application/json">${serializeJsonForScript(diffHtml)}</script>
    <script>${escapeScript(graphAssets.js)}</script>
  </body>
</html>`;
}

async function getGraphAssets() {
  graphAssetsPromise ||= buildGraphAssets();
  return graphAssetsPromise;
}

async function buildGraphAssets() {
  const [bundle, jsonViewCss, webCss] = await Promise.all([
    esbuild.build({
      entryPoints: [GRAPH_APP_ENTRY],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "PrReviewGraph",
      target: "es2020",
      jsx: "automatic",
      plugins: [aliasAtPlugin()],
      logLevel: "silent",
    }),
    readFile(JSON_VIEW_CSS_PATH, "utf8"),
    buildWebCss(),
  ]);

  const js = bundle.outputFiles[0]?.text;

  if (!js) {
    throw new Error("Failed to build graph webview bundle.");
  }

  return {
    css: `${await readFile(require.resolve("@xyflow/react/dist/style.css"), "utf8")}\n${jsonViewCss}\n${webCss}`,
    js,
  };
}

async function buildWebCss() {
  const source = await readFile(WEB_STYLES_ENTRY, "utf8");
  const result = await postcss([tailwindcss()]).process(source, { from: WEB_STYLES_ENTRY });
  return result.css;
}

async function getSyntaxHighlighter() {
  syntaxHighlighterPromise ||= createHighlighter({
    langs: SHIKI_LANGUAGES,
    themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark],
  });

  return syntaxHighlighterPromise;
}

function aliasAtPlugin() {
  return {
    name: "alias-at",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        if (args.path === "@/lib/utils") {
          return { path: path.join(ROOT_DIR, "lib/utils.js") };
        }

        return { path: path.join(ROOT_DIR, args.path.slice(2)) };
      });
    },
  };
}

function buildGraphData({ analysis, diff, syntaxHighlighter }) {
  const inventory = createDiffInventory(diff);
  const inventoryIndex = indexDiffInventory(inventory);

  if (
    analysis.schemaVersion === "pr-graph-mini-trees/v1"
    || analysis.schemaVersion === "pr-graph-mini-trees/v2"
  ) {
    return buildGraphDataMiniTrees({
      analysis,
      inventoryIndex,
      syntaxHighlighter,
    });
  }

  if (analysis.superTree?.nodes) {
    return buildGraphDataV3({
      analysis,
      inventoryIndex,
      syntaxHighlighter,
    });
  }

  if (Array.isArray(analysis.reviewGroups)) {
    return buildGraphDataV2({
      analysis,
      inventoryIndex,
      syntaxHighlighter,
    });
  }

  return buildGraphDataV1({
    analysis,
    inventoryIndex,
    diff,
    syntaxHighlighter,
  });
}

function buildGraphDataMiniTrees({ analysis, inventoryIndex, syntaxHighlighter }) {
  return {
    schemaVersion: analysis.schemaVersion,
    intent: analysis.intent || "",
    summary: analysis.summary || "",
    confidence: analysis.confidence ?? null,
    files: (analysis.files || []).map((file) => {
      const miniTree = {
        relations: file.miniTree?.relations || [],
        reviewEdges: normalizeReviewEdges(file.miniTree),
        nodes: file.miniTree?.nodes || [],
      };

      return {
        id: file.id,
        path: file.path,
        reviewClass: file.reviewClass,
        changeRole: file.changeRole,
        comment: file.comment || "",
        codeRefs: normalizeCodeRefs(file.codeRefs),
        fileOrderCodeChunks: buildCodeChunksForFile({
          file,
          inventoryIndex,
          syntaxHighlighter,
        }),
        miniTree: {
          nodes: miniTree.nodes.map((miniNode) => ({
            id: miniNode.id,
            title: miniNode.title,
            reviewClass: miniNode.reviewClass,
            changeRole: miniNode.changeRole,
            depth: miniNode.depth,
            comment: miniNode.comment || "",
            changedLineIds: miniNode.changedLineIds || [],
            codeChunks: buildCodeChunksForMiniNode({
              file,
              miniNode,
              inventoryIndex,
              syntaxHighlighter,
            }),
          })),
          reviewEdges: miniTree.reviewEdges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            order: edge.order,
            comment: edge.comment || "",
          })),
          relations: miniTree.relations.map((relation) => ({
            from: relation.from,
            to: relation.to,
            relation: relation.relation || "",
            comment: relation.comment || "",
          })),
        },
      };
    }),
  };
}

function normalizeReviewEdges(miniTree) {
  const edges = miniTree?.reviewEdges || miniTree?.edges || [];
  const nextOrderByParentId = new Map();

  return edges.map((edge) => {
    const fallbackOrder = nextOrderByParentId.get(edge.from) || 0;
    const order = Number.isInteger(edge.order) ? edge.order : fallbackOrder;
    nextOrderByParentId.set(edge.from, Math.max(fallbackOrder, order) + 1);

    return {
      ...edge,
      order,
    };
  });
}

function buildGraphDataV3({ analysis, inventoryIndex, syntaxHighlighter }) {
  const superNodeById = new Map((analysis.superTree?.nodes || []).map((node) => [node.id, node]));

  return {
    schemaVersion: analysis.schemaVersion,
    intent: analysis.intent || "",
    summary: analysis.summary || "",
    confidence: analysis.confidence ?? null,
    files: (analysis.files || []).map((file) => {
      const miniTree = {
        edges: file.miniTree?.edges || file.miniEdges || [],
        nodes: file.miniTree?.nodes || file.miniNodes || [],
      };
      const miniNodes = miniTree.nodes.map((miniNode) => ({
        id: miniNode.id,
        title: miniNode.title,
        reviewClass: miniNode.reviewClass,
        changeRole: miniNode.changeRole,
        depth: miniNode.depth,
        comment: miniNode.comment || "",
        changedLineIds: miniNode.changedLineIds || [],
        codeChunks: buildCodeChunksForMiniNode({
          file,
          miniNode,
          inventoryIndex,
          syntaxHighlighter,
        }),
      }));

      return {
        id: file.id,
        path: file.path,
        reviewClass: file.reviewClass,
        changeRole: file.changeRole,
        comment: file.comment || "",
        codeRefs: normalizeCodeRefs(file.codeRefs),
        miniTree: {
          nodes: miniNodes,
          edges: miniTree.edges || [],
        },
      };
    }),
    superTree: {
      nodes: (analysis.superTree?.nodes || []).map((superNode) => ({
        id: superNode.id,
        title: superNode.title,
        reviewClass: superNode.reviewClass,
        changeRole: superNode.changeRole,
        depth: superNode.depth,
        comment: superNode.comment || "",
        confidence: superNode.confidence ?? null,
        codeRefs: normalizeCodeRefs(superNode.codeRefs),
        tree: {
          nodes: (superNode.tree?.nodes || []).map((treeNode) => ({
            id: treeNode.id,
            title: treeNode.title,
            reviewClass: treeNode.reviewClass,
            changeRole: treeNode.changeRole,
            depth: treeNode.depth,
            comment: treeNode.comment || "",
            confidence: treeNode.confidence ?? null,
            codeRefs: normalizeCodeRefs(treeNode.codeRefs),
          })),
          edges: (superNode.tree?.edges || []).map((edge) => ({
            from: edge.from,
            to: edge.to,
            relation: edge.relation || "",
            comment: edge.comment || "",
          })),
        },
      })),
      edges: (analysis.superTree?.edges || [])
        .filter((edge) => superNodeById.has(edge.from) && superNodeById.has(edge.to))
        .map((edge) => ({
          from: edge.from,
          to: edge.to,
          relation: edge.relation || "",
          comment: edge.comment || "",
        })),
    },
  };
}

function buildGraphDataV2({ analysis, inventoryIndex, syntaxHighlighter }) {
  const groupById = new Map((analysis.reviewGroups || []).map((group) => [group.id, group]));

  return {
    schemaVersion: analysis.schemaVersion,
    intent: analysis.intent || "",
    summary: analysis.summary || "",
    confidence: analysis.confidence ?? null,
    files: (analysis.files || []).map((file) => ({
      id: file.id,
      path: file.path,
      reviewClass: file.reviewClass,
      changeRole: file.changeRole,
      comment: file.comment || "",
      miniNodes: (file.miniNodes || []).map((miniNode) => ({
        id: miniNode.id,
        title: miniNode.title,
        reviewClass: miniNode.reviewClass,
        changeRole: miniNode.changeRole,
        depth: miniNode.depth,
        comment: miniNode.comment || "",
        changedLineIds: miniNode.changedLineIds || [],
        codeChunks: buildCodeChunksForMiniNode({
          file,
          miniNode,
          inventoryIndex,
          syntaxHighlighter,
        }),
      })),
      miniEdges: file.miniEdges || [],
    })),
    reviewGroups: (analysis.reviewGroups || []).map((group) => ({
      id: group.id,
      title: group.title,
      reviewClass: group.reviewClass,
      changeRole: group.changeRole,
      depth: group.depth,
      comment: group.comment || "",
      confidence: group.confidence ?? null,
      fileIds: group.fileIds || [],
    })),
    superEdges: (analysis.superEdges || [])
      .filter((edge) => groupById.has(edge.from) && groupById.has(edge.to))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        relation: edge.relation || "",
        comment: edge.comment || "",
      })),
  };
}

function normalizeCodeRefs(codeRefs) {
  return {
    fileIds: codeRefs?.fileIds || [],
    changedLineIds: codeRefs?.changedLineIds || [],
  };
}

function buildGraphDataV1({ analysis, inventoryIndex, diff, syntaxHighlighter }) {
  const parsedDiff = parseUnifiedDiff(diff);
  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));
  const sectionById = new Map((analysis.sections || []).map((section) => [section.id, section]));

  return {
    schemaVersion: analysis.schemaVersion,
    sections: (analysis.sections || []).map((section) => ({
      id: section.id,
      title: section.title,
      file: section.file,
      classification: section.classification,
      comment: section.comment || "",
      changedLineIds: section.changedLineIds || [],
    })),
    nodes: analysis.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      kind: node.kind,
      depth: node.depth,
      comment: node.comment || "",
      confidence: node.confidence ?? null,
      sectionIds: node.sectionIds || [],
      codeChunks: buildCodeChunksForNode({
        inventoryIndex,
        node,
        parsedDiff,
        sectionById,
        syntaxHighlighter,
      }),
    })),
    edges: (analysis.edges || [])
      .filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        relation: edge.relation || "",
        comment: edge.comment || "",
      })),
    virtualStacks: (analysis.virtualStacks || [])
      .slice()
      .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
      .map((stack) => ({
        id: stack.id,
        title: stack.title,
        priority: stack.priority,
        comment: stack.comment || "",
        nodeIds: stack.nodeIds || [],
        sectionIds: stack.sectionIds || [],
      })),
  };
}

function buildCodeChunksForMiniNode({ file, inventoryIndex, miniNode, syntaxHighlighter }) {
  const changedLinesByHunk = new Map();

  for (const changedLineId of miniNode.changedLineIds || []) {
    const indexedLine = inventoryIndex.lineById.get(changedLineId);

    if (!indexedLine) {
      continue;
    }

    const hunkLines = changedLinesByHunk.get(indexedLine.hunk.id) || [];
    hunkLines.push(indexedLine);
    changedLinesByHunk.set(indexedLine.hunk.id, hunkLines);
  }

  return [...changedLinesByHunk.values()].flatMap((changedLines) => {
    const sortedLines = changedLines
      .slice()
      .sort((left, right) => left.lineIndex - right.lineIndex);
    const runs = [];

    for (const indexedLine of sortedLines) {
      const currentRun = runs.at(-1);
      const previousLine = currentRun?.at(-1);

      if (!previousLine || indexedLine.lineIndex !== previousLine.lineIndex + 1) {
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
      const end = contextBoundary({
        direction: 1,
        hunk,
        ownedLineIds,
        startIndex: lastLineIndex,
      }) + 1;
      const lines = hunk.lines.slice(start, end).map((line) => inventoryLineToSnippetLine(line));

      return {
        file: file.path,
        hunk: `${miniNode.reviewClass}/${miniNode.changeRole} · ${miniNode.title} · ${hunk.header}`.trim(),
        lines: highlightSnippetLines({
          contextLines: hunk.lines
            .slice(0, start)
            .map((line) => inventoryLineToSnippetLine(line)),
          file: file.path,
          lines,
          syntaxHighlighter,
        }),
      };
    });
  });
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

function buildCodeChunksForNode({ inventoryIndex, node, parsedDiff, sectionById, syntaxHighlighter }) {
  if (Array.isArray(node.sectionIds) && node.sectionIds.length > 0) {
    const chunks = [];

    for (const sectionId of node.sectionIds) {
      const section = sectionById.get(sectionId);

      if (!section) {
        continue;
      }

      chunks.push(...buildCodeChunksForSection({
        inventoryIndex,
        section,
        syntaxHighlighter,
      }));
    }

    if (chunks.length > 0) {
      return chunks.slice(0, 4);
    }
  }

  const chunks = [];
  const seen = new Set();
  const evidenceGroups = new Map();

  for (const evidence of node.evidence || []) {
    const groupKey = `${evidence.file}:${evidence.hunk || ""}`;
    if (!evidenceGroups.has(groupKey)) {
      evidenceGroups.set(groupKey, evidence);
    }
  }

  for (const evidence of evidenceGroups.values()) {
    const file = parsedDiff.files.find((candidate) => candidate.path === evidence.file);
    const hunk = findHunk(file, evidence.hunk);
    const lines = hunk ? selectSnippetLines({ hunk, evidence }) : fallbackSnippetLines(evidence.excerpt);
    const key = `${evidence.file}:${evidence.hunk}:${lines.map((line) => `${line.type}:${line.oldLine}:${line.newLine}:${line.content}`).join("|")}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    chunks.push({
      file: evidence.file,
      hunk: evidence.hunk || hunk?.header || "",
      lines: highlightSnippetLines({
        file: evidence.file,
        lines,
        syntaxHighlighter,
      }),
    });
  }

  if (chunks.length === 0) {
    const fallbackLines = fallbackSnippetLines(node.title);

    chunks.push({
      file: "unknown",
      hunk: "",
      lines: highlightSnippetLines({
        file: "unknown",
        lines: fallbackLines,
        syntaxHighlighter,
      }),
    });
  }

  return chunks.slice(0, 3);
}

function buildCodeChunksForSection({ inventoryIndex, section, syntaxHighlighter }) {
  const changedLinesByHunk = new Map();

  for (const changedLineId of section.changedLineIds || []) {
    const indexedLine = inventoryIndex.lineById.get(changedLineId);

    if (!indexedLine) {
      continue;
    }

    const hunkLines = changedLinesByHunk.get(indexedLine.hunk.id) || [];
    hunkLines.push(indexedLine);
    changedLinesByHunk.set(indexedLine.hunk.id, hunkLines);
  }

  return [...changedLinesByHunk.values()].map((changedLines) => {
    const hunk = changedLines[0].hunk;
    const indexes = changedLines.map((entry) => entry.lineIndex);
    const start = Math.max(0, Math.min(...indexes) - 2);
    const end = Math.min(hunk.lines.length, Math.max(...indexes) + 3);
    const lines = hunk.lines.slice(start, end).map((line) => inventoryLineToSnippetLine(line));

    return {
      file: section.file,
      hunk: `${section.title} · ${hunk.header}`.trim(),
      lines: highlightSnippetLines({
        contextLines: hunk.lines
          .slice(0, start)
          .map((line) => inventoryLineToSnippetLine(line)),
        file: section.file,
        lines,
        syntaxHighlighter,
      }),
    };
  });
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
    newLine: line.newLine,
    oldLine: line.oldLine,
    prefix: line.prefix,
    type: line.kind === "insert" ? "add" : line.kind === "delete" ? "del" : "context",
  };
}

function highlightSnippetLines({
  contextLines = [],
  file,
  lines,
  syntaxHighlighter,
}) {
  const lang = languageForPath(file);
  const entries = [
    ...contextLines.map((line) => ({ displayIndex: null, line })),
    ...lines.map((line, displayIndex) => ({ displayIndex, line })),
  ];
  const oldLineHtml = highlightDiffSide({
    entries: entries.filter((entry) => entry.line.type !== "add"),
    lang,
    syntaxHighlighter,
  });
  const newLineHtml = highlightDiffSide({
    entries: entries.filter((entry) => entry.line.type !== "del"),
    lang,
    syntaxHighlighter,
  });

  return lines.map((line, displayIndex) => ({
    ...line,
    highlightedHtml: (
      line.type === "del"
        ? oldLineHtml.get(displayIndex)
        : newLineHtml.get(displayIndex)
    ) ?? highlightCodeLine({
      code: line.content,
      lang,
      syntaxHighlighter,
    }),
  }));
}

function highlightDiffSide({ entries, lang, syntaxHighlighter }) {
  const htmlByDisplayIndex = new Map();
  if (entries.length === 0) {
    return htmlByDisplayIndex;
  }

  const tokenLines = tokensForSource({
    code: entries.map((entry) => entry.line.content).join("\n"),
    lang,
    syntaxHighlighter,
  });

  entries.forEach((entry, tokenLineIndex) => {
    if (entry.displayIndex === null) {
      return;
    }

    htmlByDisplayIndex.set(
      entry.displayIndex,
      renderTokenLine(tokenLines[tokenLineIndex] || []),
    );
  });

  return htmlByDisplayIndex;
}

function highlightDiffHtml({ diffHtml, syntaxHighlighter }) {
  let currentLang = "plaintext";

  return diffHtml.replace(
    /<div id="[^"]+" class="d2h-file-wrapper" data-lang="([^"]*)">|<span class="d2h-code-line-ctn">([\s\S]*?)<\/span>/g,
    (match, diffLanguage, inlineHtml) => {
      if (diffLanguage != null) {
        currentLang = normalizeShikiLanguage(diffLanguage);
        return match;
      }

      return `<span class="d2h-code-line-ctn shiki-inline-code" data-shiki-highlighted="true">${highlightInlineDiffHtml({
        inlineHtml,
        lang: currentLang,
        syntaxHighlighter,
      })}</span>`;
    },
  );
}

function highlightInlineDiffHtml({ inlineHtml, lang, syntaxHighlighter }) {
  const segments = parseInlineDiffSegments(inlineHtml);
  const code = segments.map((segment) => segment.text).join("");

  if (!code) {
    return /<br\s*\/?>/i.test(inlineHtml) ? "<br>" : "";
  }

  const tokens = tokensForLine({ code, lang, syntaxHighlighter });

  return segments
    .map((segment) => {
      const html = renderTokenRange({
        end: segment.end,
        start: segment.start,
        tokens,
      });

      return segment.tag ? `<${segment.tag}>${html}</${segment.tag}>` : html;
    })
    .join("");
}

function highlightCodeLine({ code, lang, syntaxHighlighter }) {
  const tokens = tokensForLine({ code, lang, syntaxHighlighter });

  return renderTokenRange({
    end: String(code).length,
    start: 0,
    tokens,
  });
}

function tokensForLine({ code, lang, syntaxHighlighter }) {
  return tokensForSource({ code, lang, syntaxHighlighter })[0] || [];
}

function tokensForSource({ code, lang, syntaxHighlighter }) {
  const source = String(code);
  if (!source) {
    return [[]];
  }

  try {
    return syntaxHighlighter.codeToTokens(source, {
      lang,
      themes: SHIKI_THEMES,
    }).tokens;
  } catch {
    return syntaxHighlighter.codeToTokens(source, {
      lang: "plaintext",
      themes: SHIKI_THEMES,
    }).tokens;
  }
}

function renderTokenLine(tokens) {
  return tokens
    .map((token) => renderShikiToken(token.content, token.htmlStyle))
    .join("");
}

function renderTokenRange({ end, start, tokens }) {
  let html = "";

  for (const token of tokens) {
    const tokenStart = token.offset ?? 0;
    const tokenEnd = tokenStart + token.content.length;
    const overlapStart = Math.max(start, tokenStart);
    const overlapEnd = Math.min(end, tokenEnd);

    if (overlapEnd <= overlapStart) {
      continue;
    }

    const content = token.content.slice(overlapStart - tokenStart, overlapEnd - tokenStart);
    html += renderShikiToken(content, token.htmlStyle);
  }

  return html;
}

function renderShikiToken(content, htmlStyle = {}) {
  const style = shikiTokenStyle(htmlStyle);

  if (!style) {
    return escapeHtml(content);
  }

  return `<span class="shiki-token" style="${escapeAttribute(style)}">${escapeHtml(content)}</span>`;
}

function shikiTokenStyle(htmlStyle) {
  const declarations = [];
  const lightColor = htmlStyle.color;
  const darkColor = htmlStyle["--shiki-dark"];

  if (lightColor) {
    declarations.push(`--shiki-light:${lightColor}`);
    declarations.push("color:var(--shiki-light)");
  }

  if (darkColor) {
    declarations.push(`--shiki-dark:${darkColor}`);
  }

  for (const [property, value] of Object.entries(htmlStyle)) {
    if (property === "color" || property === "--shiki-dark") {
      continue;
    }

    declarations.push(`${property}:${value}`);
  }

  return declarations.join(";");
}

function parseInlineDiffSegments(inlineHtml) {
  const segments = [];
  const tokenPattern = /<(\/?)(ins|del)>|<br\s*\/?>|([^<]+)/gi;
  let activeTag = null;
  let offset = 0;

  for (let match = tokenPattern.exec(inlineHtml); match; match = tokenPattern.exec(inlineHtml)) {
    if (match[2]) {
      activeTag = match[1] ? null : match[2].toLowerCase();
      continue;
    }

    if (match[0].startsWith("<br")) {
      continue;
    }

    const text = decodeHtmlEntities(match[3] || "");
    if (!text) {
      continue;
    }

    segments.push({
      end: offset + text.length,
      start: offset,
      tag: activeTag,
      text,
    });
    offset += text.length;
  }

  return segments;
}

function languageForPath(filePath) {
  const extension = String(filePath).split(".").pop()?.toLowerCase() || "";
  return normalizeShikiLanguage(LANGUAGE_BY_EXTENSION.get(extension) || extension);
}

function normalizeShikiLanguage(language) {
  const normalized = SHIKI_LANGUAGE_ALIASES.get(String(language || "").toLowerCase()) || String(language || "").toLowerCase();
  return SHIKI_LANGUAGE_SET.has(normalized) ? normalized : "plaintext";
}

function parseUnifiedDiff(diff) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentFile = { path: "", hunks: [] };
      currentHunk = null;
      files.push(currentFile);
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("+++ b/")) {
      currentFile.path = line.slice("+++ b/".length);
      continue;
    }

    if (line.startsWith("@@ ")) {
      const ranges = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = ranges ? Number(ranges[1]) : 0;
      newLine = ranges ? Number(ranges[2]) : 0;
      currentHunk = {
        header: line,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({ content: line.slice(1), newLine, oldLine: null, prefix: "+", type: "add" });
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push({ content: line.slice(1), newLine: null, oldLine, prefix: "-", type: "del" });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ content: line.slice(1), newLine, oldLine, prefix: " ", type: "context" });
      oldLine += 1;
      newLine += 1;
    }
  }

  return { files };
}

function findHunk(file, hunkLabel) {
  if (!file || file.hunks.length === 0) {
    return null;
  }

  if (!hunkLabel) {
    return file.hunks[0];
  }

  return file.hunks.find((hunk) => hunk.header.startsWith(hunkLabel)) || file.hunks[0];
}

function selectSnippetLines({ hunk, evidence }) {
  const scoredIndex = bestMatchingLineIndex({ lines: hunk.lines, excerpt: evidence.excerpt });
  const changedIndexes = hunk.lines
    .map((line, index) => (line.type === "add" || line.type === "del" ? index : -1))
    .filter((index) => index >= 0);

  if (scoredIndex >= 0) {
    return trimSnippet(expandAroundIndex({ lines: hunk.lines, index: scoredIndex }));
  }

  if (changedIndexes.length > 0) {
    return trimSnippet(expandAroundIndex({ lines: hunk.lines, index: changedIndexes[0] }));
  }

  return trimSnippet(hunk.lines.slice(0, 8));
}

function bestMatchingLineIndex({ lines, excerpt }) {
  const tokens = significantTokens(excerpt);
  const excerptText = String(excerpt).toLowerCase();
  let best = { index: -1, score: 0 };

  lines.forEach((line, index) => {
    const content = line.content.toLowerCase();
    let score = tokens.reduce((sum, token) => (content.includes(token) ? sum + 1 : sum), 0);

    for (const keyword of ["focus", "pressable", "ref", "pointerevents", "onpress"]) {
      if (excerptText.includes(keyword) && content.includes(keyword)) {
        score += 4;
      }
    }

    if (score > best.score) {
      best = { index, score };
    }
  });

  return best.score > 0 ? best.index : -1;
}

function significantTokens(text) {
  const ignored = new Set(["const", "event", "props", "string", "code", "value", "length", "null", "true", "false"]);

  return [...new Set(String(text).toLowerCase().match(/[a-z0-9_]+/g) || [])]
    .filter((token) => token.length > 2 && !ignored.has(token))
    .slice(0, 12);
}

function expandAroundIndex({ lines, index }) {
  const start = Math.max(0, index - 2);
  const end = Math.min(lines.length, index + 6);
  return lines.slice(start, end);
}

function trimSnippet(lines) {
  const changedIndexes = lines
    .map((line, index) => (line.type === "add" || line.type === "del" ? index : -1))
    .filter((index) => index >= 0);

  if (changedIndexes.length === 0) {
    return lines.slice(0, 8);
  }

  const start = Math.max(0, changedIndexes[0] - 2);
  const end = Math.min(lines.length, changedIndexes[changedIndexes.length - 1] + 3);
  return lines.slice(start, end).slice(0, 9);
}

function fallbackSnippetLines(excerpt) {
  return String(excerpt)
    .split("\n")
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => ({
      content: line,
      newLine: null,
      oldLine: null,
      prefix: " ",
      type: "context",
    }));
}

function decodeHtmlEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();

    if (normalized.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    }

    if (normalized.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    }

    return (
      {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: "\"",
      }[normalized] || match
    );
  });
}

function buildReviewData({ graphData, pr }) {
  return {
    additions: pr.additions ?? null,
    authorLogin: pr.author?.login || "",
    baseRefName: pr.baseRefName || "",
    changedFiles: pr.changedFiles ?? null,
    deletions: pr.deletions ?? null,
    edgeCount: graphData?.superTree?.edges?.length ?? graphData?.superEdges?.length ?? graphData?.edges?.length ?? 0,
    headRefName: pr.headRefName || "",
    nodeCount: graphData?.superTree?.nodes?.length ?? graphData?.reviewGroups?.length ?? graphData?.nodes?.length ?? 0,
    number: pr.number ?? null,
    state: pr.state || "",
    title: pr.title || "",
    url: pr.url || "",
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function serializeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeScript(value) {
  return String(value).replace(/<\/script/gi, "<\\/script");
}
