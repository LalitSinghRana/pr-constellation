import { createHighlighter } from "shiki";

const themes = { light: "light-plus", dark: "dark-plus" };
const languages = [
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
const languageSet = new Set(languages);
const languageByExtension = new Map([
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
const languageAliases = new Map([
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
let highlighterPromise;

export function getSyntaxHighlighter() {
  highlighterPromise ||= createHighlighter({
    langs: languages,
    themes: [themes.light, themes.dark],
  });
  return highlighterPromise;
}

export function highlightSnippetLines({ contextLines = [], file, lines, syntaxHighlighter }) {
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
    if (entry.displayIndex !== null) {
      tokensByDisplayIndex.set(
        entry.displayIndex,
        (tokenLines[tokenLineIndex] || []).map(toSyntaxToken),
      );
    }
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
    return syntaxHighlighter.codeToTokens(source, { lang, themes }).tokens;
  } catch {
    return syntaxHighlighter.codeToTokens(source, { lang: "plaintext", themes }).tokens;
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
    if (property !== "color" && property !== "--shiki-dark") {
      declarations.push(`${property}:${value}`);
    }
  }

  return declarations.join(";");
}

function languageForPath(filePath) {
  const extension = String(filePath).split(".").pop()?.toLowerCase() || "";
  const language =
    languageAliases.get(extension) || languageByExtension.get(extension) || extension;
  return languageSet.has(language) ? language : "plaintext";
}
