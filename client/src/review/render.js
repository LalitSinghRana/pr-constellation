import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import esbuild from "esbuild";
import postcss from "postcss";
import { createHighlighter } from "shiki";
import { createDiffInventory } from "../../../analysis-worker/workflow/03-build-diff-inventory/diff-inventory.js";

const require = createRequire(import.meta.url);
const REVIEW_TREE_APP_ENTRY = fileURLToPath(new URL("./review-tree-app.jsx", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const WEB_STYLES_ENTRY = fileURLToPath(new URL("./styles.css", import.meta.url));
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
let syntaxHighlighterPromise;

export async function renderDiffHtml({ analysis = null, pr, diff }) {
  const syntaxHighlighter = await getSyntaxHighlighter();
  const reviewAssets = await getReviewAssets();
  const treeData = analysis ? buildReviewTreeData({ analysis, diff, syntaxHighlighter }) : null;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(pr.title)} · PR #${escapeHtml(String(pr.number))}</title>
    <script>
      (() => {
        const savedTheme = localStorage.getItem("theme");
        document.documentElement.classList.toggle(
          "dark",
          savedTheme ? savedTheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches,
        );
      })();
    </script>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@100..900&display=swap" rel="stylesheet" />
    <style>
${reviewAssets?.css || ""}
    </style>
  </head>
  <body>
    <div id="pr-review-root"></div>
    <script id="pr-review-data" type="application/json">${serializeJsonForScript(buildReviewData({ pr }))}</script>
    <script id="pr-analysis-data" type="application/json">${serializeJsonForScript(treeData)}</script>
    <script>${escapeScript(reviewAssets.js)}</script>
  </body>
</html>`;
}

async function getReviewAssets() {
  return buildReviewAssets();
}

async function buildReviewAssets() {
  const [bundle, webCss] = await Promise.all([
    esbuild.build({
      entryPoints: [REVIEW_TREE_APP_ENTRY],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "PrReviewTree",
      target: "es2020",
      jsx: "automatic",
      plugins: [aliasAtPlugin()],
      logLevel: "silent",
    }),
    buildWebCss(),
  ]);

  const js = bundle.outputFiles[0]?.text;

  if (!js) {
    throw new Error("Failed to build review tree bundle.");
  }

  const diffViewCss = await readFile(
    require.resolve("@git-diff-view/react/styles/diff-view.css"),
    "utf8",
  );

  return {
    css: `${await readFile(require.resolve("@xyflow/react/dist/style.css"), "utf8")}\n${diffViewCss}\n${webCss}`,
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
          return { path: path.join(SRC_DIR, "lib/utils.js") };
        }

        return { path: path.join(SRC_DIR, args.path.slice(2)) };
      });
    },
  };
}

function buildReviewTreeData({ analysis, diff, syntaxHighlighter }) {
  if (analysis.schemaVersion !== "pr-review-analysis/v1") {
    throw new Error(`Unsupported review analysis schema: ${analysis.schemaVersion}`);
  }

  const inventoryIndex = indexDiffInventory(createDiffInventory(diff));
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

function highlightSnippetLines({ contextLines = [], file, lines, syntaxHighlighter }) {
  const lang = languageForPath(file);
  const entries = [
    ...contextLines.map((line) => ({ displayIndex: null, line })),
    ...lines.map((line, displayIndex) => ({ displayIndex, line })),
  ];
  const oldLineTokens = highlightDiffSideTokens({
    entries: entries.filter((entry) => entry.line.type !== "add"),
    lang,
    syntaxHighlighter,
  });
  const newLineTokens = highlightDiffSideTokens({
    entries: entries.filter((entry) => entry.line.type !== "del"),
    lang,
    syntaxHighlighter,
  });

  return lines.map((line, displayIndex) => ({
    ...line,
    syntaxTokens:
      (line.type === "del" ? oldLineTokens.get(displayIndex) : newLineTokens.get(displayIndex)) ??
      tokensForLine({ code: line.content, lang, syntaxHighlighter }).map(toSyntaxToken),
  }));
}

function highlightDiffSideTokens({ entries, lang, syntaxHighlighter }) {
  const tokensByDisplayIndex = new Map();
  if (entries.length === 0) {
    return tokensByDisplayIndex;
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

    tokensByDisplayIndex.set(
      entry.displayIndex,
      (tokenLines[tokenLineIndex] || []).map(toSyntaxToken),
    );
  });

  return tokensByDisplayIndex;
}

function toSyntaxToken(token) {
  const style = shikiTokenStyle(token.htmlStyle);
  return style ? { content: token.content, style } : { content: token.content };
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

function shikiTokenStyle(htmlStyle) {
  const declarations = [];
  const lightColor = htmlStyle.color;
  const darkColor = htmlStyle["--shiki-dark"];

  if (lightColor) {
    declarations.push(`--shiki-light:${lightColor}`);
    declarations.push("color:var(--shiki-color,var(--shiki-light))");
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

function languageForPath(filePath) {
  const extension = String(filePath).split(".").pop()?.toLowerCase() || "";
  return normalizeShikiLanguage(LANGUAGE_BY_EXTENSION.get(extension) || extension);
}

function normalizeShikiLanguage(language) {
  const normalized =
    SHIKI_LANGUAGE_ALIASES.get(String(language || "").toLowerCase()) ||
    String(language || "").toLowerCase();
  return SHIKI_LANGUAGE_SET.has(normalized) ? normalized : "plaintext";
}

function buildReviewData({ pr }) {
  return {
    additions: pr.additions ?? null,
    authorLogin: pr.author?.login || "",
    baseRefName: pr.baseRefName || "",
    changedFiles: pr.changedFiles ?? null,
    deletions: pr.deletions ?? null,
    headRefName: pr.headRefName || "",
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

function serializeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeScript(value) {
  return String(value).replace(/<\/script/gi, "<\\/script");
}
