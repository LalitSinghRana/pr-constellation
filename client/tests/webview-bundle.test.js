import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDiffInventory } from "../../analysis-worker/workflow/03-build-diff-inventory/diff-inventory.js";
import { buildReviewData, buildReviewTreeData } from "../src/review/build-review-tree-data.js";
import { getSyntaxHighlighter, languagesForFilePaths } from "../src/review/shiki-highlighter.js";

const analysis = {
  schemaVersion: "pr-review-analysis/v1",
  intent: "Check review tree rendering",
  summary: "A minimal Section Tree verifies the embedded review bundle.",
  confidence: 1,
  reviewStacks: [
    {
      id: "stack-1",
      title: "Runtime change",
      explanation: "Review the runtime change as one stack.",
      fileIds: ["file-1"],
      fileTree: { branches: [] },
    },
  ],
  files: [
    {
      id: "file-1",
      path: "src/example.js",
      reviewPriority: "primary",
      changeKind: "runtime",
      explanation: "This file owns the runtime behavior under review.",
      changedLineIds: ["file-1:hunk-1:line-1", "file-1:hunk-1:line-2"],
      sectionTree: {
        sections: [
          {
            id: "replace-old-value",
            title: "Replace old value",
            reviewPriority: "primary",
            changeKind: "runtime",
            explanation: "Callers must observe the updated behavior.",
            changedLineIds: ["file-1:hunk-1:line-1"],
          },
          {
            id: "set-new-value",
            title: "Set new value",
            reviewPriority: "secondary",
            changeKind: "runtime",
            explanation: "The replacement value supports the reviewed behavior.",
            changedLineIds: ["file-1:hunk-1:line-2"],
          },
        ],
        branches: [
          {
            parentId: "replace-old-value",
            childId: "set-new-value",
            order: 0,
            explanation: "The assignment supplies the value callers now observe.",
          },
        ],
      },
    },
  ],
};

const diff = `diff --git a/src/example.js b/src/example.js
index 0000000..1111111 100644
--- a/src/example.js
+++ b/src/example.js
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`;

const pr = {
  additions: 1,
  author: { avatarUrl: "https://example.com/check.png", login: "check" },
  baseRefName: "main",
  body: "## Description\n\nReview the change.",
  changedFiles: 1,
  createdAt: "2026-08-09T12:00:00Z",
  deletions: 1,
  headRefName: "branch",
  number: 1,
  state: "OPEN",
  title: "Check",
  url: "https://github.com/example/repo/pull/1",
};

assert.deepEqual(languagesForFilePaths(["src/example.js", "README.md"]), [
  "javascript",
  "markdown",
]);

const syntaxHighlighter = await getSyntaxHighlighter(languagesForFilePaths(["src/example.js"]));
const diffInventory = createDiffInventory(diff);
const treeData = buildReviewTreeData({ analysis, diffInventory, syntaxHighlighter });
const reviewData = buildReviewData({ pr });

assert.equal(reviewData.body, "## Description\n\nReview the change.");
assert.equal(reviewData.authorAvatarUrl, "https://example.com/check.png");
assert.equal(treeData.schemaVersion, "pr-review-analysis/v1");
assert.equal(treeData.reviewStacks[0].fileTree.branches.length, 0);
assert.equal(treeData.files[0].sectionTree.branches[0].order, 0);
assert.match(treeData.files[0].sectionTree.branches[0].explanation, /supplies/);
assert.equal(treeData.files[0].sectionTree.sections[0].codeChunks.length, 1);
assert.equal(treeData.files[0].sourceCodeChunks.length, 1);
assert.deepEqual(
  treeData.files[0].sourceCodeChunks[0].lines.map((line) => line.content),
  ["const value = 1;", "const value = 2;"],
);
assert.ok(
  treeData.files[0].sourceCodeChunks[0].lines
    .flatMap((line) => line.syntaxTokens)
    .some((token) => token.style?.includes("--shiki-light")),
  "the browser highlighter should provide styled syntax tokens",
);
assert.ok(
  treeData.files[0].sourceCodeChunks[0].lines
    .flatMap((line) => line.syntaxTokens)
    .some((token) => token.style?.includes("--shiki-dark")),
  "the browser highlighter should provide dark-theme syntax tokens",
);
assert.ok(!("relations" in treeData.files[0].sectionTree));

const reviewUiFiles = [
  "review-tree-app.jsx",
  "review-header.jsx",
  "review-draft-sheet.jsx",
  "review-draft-panel.jsx",
  "pull-request-conversation.jsx",
  "review-tree-canvas.jsx",
  "review-tree-nodes.jsx",
  "diff-chunk-view.jsx",
  "inline-comment-composer.jsx",
  "explanation-hover-card.jsx",
  "github-markdown.jsx",
];
const [treeAppSources, treeLayoutSource, webStyles] = await Promise.all([
  Promise.all(
    reviewUiFiles.map((file) =>
      readFile(new URL(`../src/review/${file}`, import.meta.url), "utf8"),
    ),
  ),
  readFile(new URL("../src/review/review-tree/layout.js", import.meta.url), "utf8"),
  readFile(new URL("../src/review/react-flow.css", import.meta.url), "utf8"),
]);
const treeAppSource = treeAppSources.join("\n");
const reviewTreeSource = `${treeAppSource}\n${treeLayoutSource}`;
assert.match(reviewTreeSource, /nodesDraggable=\{false\}/);
assert.match(reviewTreeSource, /reviewBranch: React\.memo\(ReviewBranch\)/);
assert.match(reviewTreeSource, /filter\(\(\{ type \}\) => type === "reviewSection"\)/);
assert.match(
  reviewTreeSource,
  /foldSectionTree\(file, \{ expandedGroupIds, foldGroups, showSecondaryRuntime \}\)/,
);
assert.match(treeAppSource, /aria-label="Review tree density"/);
assert.match(treeAppSource, /REVIEW_TREE_DENSITY_MODES/);
assert.match(treeAppSource, /absolute top-4 right-\[18px\]/);
assert.match(reviewTreeSource, /value="source"/);
assert.match(reviewTreeSource, /ariaLabel="Review tree map"/);
assert.match(reviewTreeSource, /pointerEvents: "auto"/);
assert.match(treeAppSource, /text-sm font-normal leading-normal/);
assert.match(treeAppSource, /<ReviewDraftSheet \/>/);
assert.match(treeAppSource, /MessageSquarePlus aria-hidden="true" size=\{16\}/);
assert.match(treeAppSource, /value="conversation"/);
assert.match(treeAppSource, /function conversationIcon/);
assert.match(treeAppSource, /item\.state === "APPROVED"\) return Check/);
assert.match(treeAppSource, /item\.state === "COMMENTED"\) return MessageSquare/);
assert.match(treeAppSource, /<Timeline/);
assert.match(treeAppSource, /unstyled/);
assert.match(treeAppSource, /w-px flex-1 bg-border/);
assert.match(treeAppSource, /import \{ GitHubMarkdown \} from "\.\/github-markdown\.jsx"/);
assert.match(treeAppSource, /githubMarkdownRemarkPlugins/);
assert.match(treeAppSource, /githubMarkdownRehypePlugins/);
assert.match(treeAppSource, /MIN_TREE_ZOOM/);
assert.match(treeAppSource, /if \(item\.kind === "description"\) return 0;/);
assert.match(treeAppSource, /FILE_TREE_TARGET_HANDLE/);
assert.match(treeAppSource, /text-pr-open/);
assert.match(
  treeAppSource,
  /import \{ MiddleEllipsis \} from "\.\.\/components\/ui\/middle-ellipsis\/index\.js"/,
);
assert.match(
  treeAppSource,
  /absolute top-\[11px\] right-3\.5 left-3\.5 flex min-w-0 items-center gap-12/,
);
assert.match(treeAppSource, /relative min-w-0 flex-\[3\]/);
assert.match(treeAppSource, /min-w-0 flex-\[1\] justify-end/);
assert.match(
  treeAppSource,
  /max-w-full min-w-0 justify-start gap-2 overflow-hidden px-2\.5 py-2 font-mono/,
);
assert.doesNotMatch(
  treeAppSource,
  /max-w-full min-w-0 justify-start gap-2 overflow-hidden relative w-full/,
);
assert.match(treeAppSource, /<MiddleEllipsis\.Span\s+className="min-w-0 flex-1"/);
assert.match(
  treeAppSource,
  /grid grid-cols-\[minmax\(0,1fr\)_auto\] items-center justify-between gap-8/,
);
assert.doesNotMatch(treeAppSource, /\[&>span\]:truncate/);
assert.match(treeAppSource, /relative m-0 min-w-0 flex-1 overflow-hidden font-display text-xl/);
assert.doesNotMatch(treeAppSource, /min-w-\[120px\] flex-auto truncate /);
assert.match(treeAppSource, /export function ReviewTreeApp/);
assert.doesNotMatch(treeAppSource, /createRoot\(/);
assert.doesNotMatch(treeAppSource, /What \/ Why/);
assert.doesNotMatch(treeAppSource, /formatExplanationForHover/);
assert.doesNotMatch(treeAppSource, /state-badge/);
assert.doesNotMatch(treeAppSource, /text-\[15px\]/);
assert.doesNotMatch(treeAppSource, /formatTimelineTimestamp/);
assert.match(treeAppSource, /hasDraft && !isActiveReply/);
assert.match(treeAppSource, /\{hasDraft \? "Edit" : "Reply"\}/);
assert.match(treeAppSource, /<Badge variant="secondary">Draft<\/Badge>/);
assert.match(treeAppSource, /<GitHubMarkdown body=\{draftBody\}/);
assert.match(
  treeAppSource,
  /if \(entry\?\.githubThread\) \{\s*setPendingTarget\(null\);\s*setComposerBody\(""\);/,
);
assert.match(
  treeAppSource,
  /nodrag nopan pointer-events-auto absolute right-full z-20 mr-3 max-h-80/,
);
assert.doesNotMatch(treeAppSource, /nowheel pointer-events-auto absolute right-full/);
assert.match(treeAppSource, /min-h-16 max-h-32 w-full shrink-0 resize-y/);
assert.match(treeAppSource, /max-h-48 gap-3 overflow-y-auto/);
assert.doesNotMatch(treeAppSource, /grid min-h-0 flex-1 gap-3 overflow-y-auto/);
assert.match(webStyles, /\.review-branch-hit-path/);
assert.match(treeAppSource, /ariaLabel="Review tree map"/);
assert.match(
  treeAppSource,
  /overflow-hidden rounded-md border border-border bg-\[color-mix\(in_oklab,var\(--card\)_92%,transparent\)\] shadow-sm backdrop-blur-\[12px\]/,
);
assert.doesNotMatch(webStyles, /\.review-tree-map/);
assert.doesNotMatch(webStyles, /\.change-pill\.is-add/);
assert.doesNotMatch(webStyles, /\.review-mark\.is-open/);
