import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderExistingRun } from "../review-run.js";

const reviewsDir = await mkdtemp(path.join(os.tmpdir(), "pr-review-hosting-"));
const slugDir = path.join(reviewsDir, "example-repo-1");
const runDir = path.join(slugDir, "run-1");

try {
  await mkdir(runDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(runDir, "metadata.json"),
      `${JSON.stringify({
        additions: 1,
        author: { login: "check" },
        baseRefName: "main",
        changedFiles: 1,
        deletions: 1,
        headRefName: "branch",
        number: 1,
        state: "OPEN",
        title: "Hosting check",
        url: "https://github.com/example/repo/pull/1",
      })}\n`,
      "utf8",
    ),
    writeFile(
      path.join(runDir, "diff.patch"),
      `diff --git a/example.js b/example.js
index 0000000..1111111 100644
--- a/example.js
+++ b/example.js
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`,
      "utf8",
    ),
  ]);

  const result = await renderExistingRun({ runDir });
  const [runHtml, stableHtml] = await Promise.all([
    readFile(path.join(runDir, "index.html"), "utf8"),
    readFile(path.join(slugDir, "index.html"), "utf8"),
  ]);

  assert.equal(result.stableHtmlPath, path.join(slugDir, "index.html"));
  assert.equal(stableHtml, runHtml);
  assert.match(stableHtml, /Hosting check/);
} finally {
  await rm(reviewsDir, { force: true, recursive: true });
}
