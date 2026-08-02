import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderDiffHtml } from "../../src/review/render.js";

const html = await renderDiffHtml({
  analysis: {
    schemaVersion: "pr-graph-mini-trees/v2",
    intent: "Check graph rendering",
    summary: "A minimal file mini-tree used to verify the embedded React Flow bundle builds.",
    confidence: 1,
    files: [
      {
        id: "file-1",
        path: "src/example.js",
        reviewClass: "important",
        changeRole: "runtime",
        comment: "This file owns the runtime behavior under review.\n\n- What: the value contract changes.\n- Why: downstream consumers need the replacement value.",
        codeRefs: {
          fileIds: ["file-1"],
          changedLineIds: ["file-1:hunk-1:line-1", "file-1:hunk-1:line-2"],
        },
        miniTree: {
          nodes: [
            {
              id: "replace-old-value",
              title: "Replace old value",
              reviewClass: "important",
              changeRole: "runtime",
              comment: "The runtime contract now exposes the replacement value.\n\n- Why: callers must observe the updated behavior.\n- Review: confirm the new value matches the PR intent.",
              changedLineIds: ["file-1:hunk-1:line-1"],
            },
            {
              id: "set-new-value",
              title: "Set new value",
              reviewClass: "supporting",
              changeRole: "runtime",
              comment: "The replacement value supports the reviewed behavior.",
              changedLineIds: ["file-1:hunk-1:line-2"],
            },
          ],
          reviewEdges: [
            {
              from: "replace-old-value",
              to: "set-new-value",
              order: 0,
              comment: "The supporting assignment follows the contract change because it supplies the value that callers will now observe.",
            },
          ],
          relations: [
            {
              from: "set-new-value",
              to: "replace-old-value",
              relation: "replaces",
              comment: "The new value replaces the removed value.",
            },
          ],
        },
      },
    ],
  },
  diff: `diff --git a/src/example.js b/src/example.js
index 0000000..1111111 100644
--- a/src/example.js
+++ b/src/example.js
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`,
  pr: {
    additions: 1,
    author: { login: "check" },
    baseRefName: "main",
    changedFiles: 1,
    deletions: 1,
    headRefName: "branch",
    number: 1,
    state: "OPEN",
    title: "Check",
    url: "https://github.com/example/repo/pull/1",
  },
});

const requiredWebviewMarkers = [
  "pr-review-root",
  "pr-analysis-schema",
  "pr-analysis-output",
  "review-tabs-list",
  "json-document-actions",
  "Expand entire JSON tree",
  "Collapse entire JSON tree",
  "flow-reader",
  "react-flow",
  "diff-tailwindcss-wrapper",
  "mini-diff-gap-divider",
  "file-page-label",
  "file-page-view-tabs",
  "mini-node-label",
  "is-review-important",
  "reviewClass",
  "changeRole",
  "mini-tree-edge",
  "Node: What / Why",
  "Review edge: What / Why",
  "collapsed-review-group",
  "--mini-tree-color",
];

const missingWebviewMarkers = requiredWebviewMarkers.filter((marker) => !html.includes(marker));
if (missingWebviewMarkers.length > 0) {
  throw new Error(`Graph webview bundle check failed. Missing: ${missingWebviewMarkers.join(", ")}`);
}

const graphData = extractJsonScript(html, "pr-analysis-data");
assert.equal(graphData.schemaVersion, "pr-graph-mini-trees/v2");
assert.equal(graphData.files[0].miniTree.reviewEdges[0].order, 0);
assert.match(graphData.files[0].miniTree.reviewEdges[0].comment, /because it supplies/);
assert.match(graphData.files[0].miniTree.nodes[0].comment, /- Review:/);
assert.equal(graphData.files[0].miniTree.relations[0].relation, "replaces");
assert.ok(!("edges" in graphData.files[0].miniTree));
assert.ok(!("depth" in graphData.files[0].miniTree.nodes[0]));
assert.equal(graphData.files[0].fileOrderCodeChunks.length, 1);
assert.deepEqual(
  graphData.files[0].fileOrderCodeChunks[0].lines.map((line) => line.content),
  ["const value = 1;", "const value = 2;"],
);

const semanticSpanHtml = await renderDiffHtml({
  analysis: {
    schemaVersion: "pr-graph-mini-trees/v2",
    intent: "Keep one cohesive render change together",
    summary: "A context-only gap must not split one semantic mini-node.",
    confidence: 1,
    files: [
      {
        id: "file-1",
        path: "src/example.tsx",
        reviewClass: "important",
        changeRole: "runtime",
        comment: "This file changes the complete interactive wrapper.",
        codeRefs: {
          fileIds: ["file-1"],
          changedLineIds: [
            "file-1:hunk-1:line-1",
            "file-1:hunk-1:line-2",
            "file-1:hunk-1:line-4",
            "file-1:hunk-1:line-5",
            "file-1:hunk-1:line-6",
          ],
        },
        miniTree: {
          nodes: [
            {
              id: "replace-wrapper",
              title: "Replace the interactive wrapper",
              reviewClass: "important",
              changeRole: "runtime",
              comment: "The opening tag, ref wiring, and closing tag form one cohesive render change.",
              changedLineIds: [
                "file-1:hunk-1:line-1",
                "file-1:hunk-1:line-2",
                "file-1:hunk-1:line-4",
                "file-1:hunk-1:line-5",
                "file-1:hunk-1:line-6",
              ],
            },
          ],
          reviewEdges: [],
          relations: [],
        },
      },
    ],
  },
  diff: `diff --git a/src/example.tsx b/src/example.tsx
index 0000000..1111111 100644
--- a/src/example.tsx
+++ b/src/example.tsx
@@ -1,3 +1,4 @@
-<View>
+<Pressable>
   <Content />
+  <HiddenInput ref={inputRef} />
-</View>
+</Pressable>
`,
  pr: {
    additions: 3,
    author: { login: "check" },
    baseRefName: "main",
    changedFiles: 1,
    deletions: 2,
    headRefName: "branch",
    number: 3,
    state: "OPEN",
    title: "Check semantic spans",
    url: "https://github.com/example/repo/pull/3",
  },
});
const semanticSpanGraphData = extractJsonScript(
  semanticSpanHtml,
  "pr-analysis-data",
);
const semanticSpanChunks =
  semanticSpanGraphData.files[0].miniTree.nodes[0].codeChunks;
assert.equal(semanticSpanChunks.length, 1);
assert.deepEqual(
  semanticSpanChunks[0].lines.map((line) => line.content),
  [
    "<View>",
    "<Pressable>",
    "  <Content />",
    "  <HiddenInput ref={inputRef} />",
    "</View>",
    "</Pressable>",
  ],
);

const [collapsibleSource, graphAppSource, webStyles] = await Promise.all([
  readFile(new URL("../../src/components/ui/collapsible.jsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/review/graph-app.jsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/review/styles.css", import.meta.url), "utf8"),
]);

assert.match(collapsibleSource, /CollapsiblePrimitive/);
assert.match(graphAppSource, /nodesDraggable=\{false\}/);
assert.match(graphAppSource, /ReactMarkdown/);
assert.match(graphAppSource, /HoverCardContent/);
assert.match(graphAppSource, /edgeTypes=\{edgeTypes\}/);
assert.match(graphAppSource, /reviewExplanation: React\.memo\(ReviewExplanationEdge\)/);
assert.match(graphAppSource, /type: "reviewExplanation"/);
assert.match(graphAppSource, /comment: edge\.comment \|\| ""/);
assert.doesNotMatch(graphAppSource, /MINI_NODE_MAX_HEIGHT/);
assert.match(graphAppSource, /MINI_CODE_CHARACTER_COLUMNS = 120/);
assert.doesNotMatch(graphAppSource, /mini-tree-technical-edge/);
assert.doesNotMatch(graphAppSource, /onNodeMouseEnter/);
assert.match(graphAppSource, /fileOrderViewIds/);
assert.match(graphAppSource, /buildFileOrderMiniTree\(file\)/);
assert.match(graphAppSource, /value="tree"/);
assert.match(graphAppSource, /value="file"/);
assert.match(graphAppSource, /<Collapsible/);
assert.match(graphAppSource, /<CollapsibleTrigger asChild>/);
assert.doesNotMatch(graphAppSource, /<button/);
assert.match(graphAppSource, /className="file-page-label"/);
assert.match(graphAppSource, /BackgroundVariant\.Dots/);
assert.match(graphAppSource, /bgColor=/);
assert.match(
  graphAppSource,
  /foldMiniTree\(file, \{ expandedGroupIds \}\)/,
);
assert.match(graphAppSource, /type:\s*item\.node\.collapsedGroup \? "collapsedGroup" : "miniDiff"/);
assert.match(graphAppSource, /nextLine\.oldLine - prevLine\.oldLine - 1/);
assert.match(graphAppSource, /unchanged lines/);
assert.ok((graphAppSource.match(/\bforceMount\b/g) || []).length >= 4);
assert.match(
  webStyles,
  /\.react-flow__node-miniDiff\s*\{[^}]*pointer-events:\s*auto\s*!important;/s,
);
assert.doesNotMatch(webStyles, /max-height:\s*340px/);
assert.doesNotMatch(webStyles, /mini-tree-technical-edge/);
assert.match(webStyles, /\.explanation-hover-comment ul/);
assert.match(webStyles, /\.comment-edge-hit-path/);

const tsxHtml = await renderDiffHtml({
  analysis: {
    schemaVersion: "pr-graph-mini-trees/v2",
    intent: "Check contextual TSX highlighting",
    summary: "Verify opening and closing component tags share full-snippet grammar context.",
    confidence: 1,
    files: [
      {
        id: "file-1",
        path: "src/example.tsx",
        reviewClass: "important",
        changeRole: "runtime",
        comment: "This file verifies contextual TSX highlighting.",
        codeRefs: {
          fileIds: ["file-1"],
          changedLineIds: [
            "file-1:hunk-1:line-1",
            "file-1:hunk-1:line-2",
            "file-1:hunk-1:line-3",
            "file-1:hunk-1:line-4",
            "file-1:hunk-1:line-5",
          ],
        },
        miniTree: {
          nodes: [
            {
              id: "render-example",
              title: "Render example",
              reviewClass: "important",
              changeRole: "runtime",
              comment: "The complete TSX range preserves grammar state.",
              changedLineIds: [
                "file-1:hunk-1:line-1",
                "file-1:hunk-1:line-2",
                "file-1:hunk-1:line-3",
                "file-1:hunk-1:line-4",
                "file-1:hunk-1:line-5",
              ],
            },
          ],
          reviewEdges: [],
          relations: [],
        },
      },
    ],
  },
  diff: `diff --git a/src/example.tsx b/src/example.tsx
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/example.tsx
@@ -0,0 +1,5 @@
+const Example = () => (
+  <View>
+    <Text>Example</Text>
+  </View>
+);
`,
  pr: {
    additions: 5,
    author: { login: "check" },
    baseRefName: "main",
    changedFiles: 1,
    deletions: 0,
    headRefName: "branch",
    number: 2,
    state: "OPEN",
    title: "Check TSX",
    url: "https://github.com/example/repo/pull/2",
  },
});
const tsxGraphData = extractJsonScript(tsxHtml, "pr-analysis-data");
const tsxLines = tsxGraphData.files[0].miniTree.nodes[0].codeChunks[0].lines;
const openingView = tsxLines.find((line) => line.content.trim() === "<View>");
const closingView = tsxLines.find((line) => line.content.trim() === "</View>");
const openingViewStyle = tokenStyleForContent(openingView?.syntaxTokens, "View");
const closingViewStyle = tokenStyleForContent(closingView?.syntaxTokens, "View");

assert.ok(openingViewStyle);
assert.equal(closingViewStyle, openingViewStyle);
assert.match(closingViewStyle, /--shiki-light:#267F99/);
assert.match(closingViewStyle, /--shiki-dark:#4EC9B0/);

function extractJsonScript(documentHtml, id) {
  const match = documentHtml.match(
    new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)<\\/script>`),
  );
  assert.ok(match, `Missing JSON script: ${id}`);
  return JSON.parse(match[1]);
}

function tokenStyleForContent(syntaxTokens, content) {
  return (syntaxTokens || []).find((token) => token.content === content)?.style || "";
}
