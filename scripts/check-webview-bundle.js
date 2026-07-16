import { renderDiffHtml } from "../src/render.js";

const html = await renderDiffHtml({
  analysis: {
    schemaVersion: "pr-graph-analysis/v1",
    intent: "Check graph rendering",
    summary: "A minimal graph used to verify the embedded React Flow bundle builds.",
    confidence: 1,
    nodes: [
      {
        id: "core-change",
        title: "Core change",
        kind: "core",
        depth: 0,
        comment: "This node verifies graph rendering.",
        confidence: 1,
        evidence: [
          {
            file: "src/example.js",
            hunk: "@@ -1 +1 @@",
            excerpt: "const value = 1;",
          },
        ],
      },
      {
        id: "support-change",
        title: "Support change",
        kind: "supporting",
        depth: 1,
        comment: "This node verifies edge rendering.",
        confidence: 1,
        evidence: [
          {
            file: "src/example.js",
            hunk: "@@ -1 +1 @@",
            excerpt: "const value = 2;",
          },
        ],
      },
    ],
    edges: [
      {
        from: "core-change",
        to: "support-change",
        relation: "requires",
        comment: "The support change is required by the core change.",
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

if (!html.includes("Logical Change Graph") || !html.includes("pr-graph-root") || !html.includes("react-flow")) {
  throw new Error("Graph webview bundle check failed.");
}
