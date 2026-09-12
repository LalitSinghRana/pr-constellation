import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../../server/analysis/run-store.js";
import {
  getLatestReviewPayload,
  getReviewPayloadForRun,
} from "../../server/review/review-payload-service.js";

const reviewsDir = await mkdtemp(path.join(os.tmpdir(), "pr-review-hosting-"));
const store = new RunStore({
  reviewsDir,
  clock: () => new Date("2026-08-13T15:00:00.000Z"),
});

try {
  const run = await store.createRun({
    runId: "run-1",
    url: "https://github.com/example/repo/pull/1",
    owner: "example",
    repo: "repo",
    number: 1,
    slug: "example-repo-1",
    title: "Hosting check",
    headSha: "head",
    baseSha: "base",
  });
  const runDir = store.getRunDir(run.slug, run.runId);
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
    writeFile(
      path.join(runDir, "diff-inventory.json"),
      `${JSON.stringify({
        schemaVersion: "diff-inventory/v1",
        changedLineCount: 2,
        files: [],
      })}\n`,
      "utf8",
    ),
    writeFile(
      path.join(runDir, "analysis.json"),
      `${JSON.stringify({
        schemaVersion: "pr-review-analysis/v1",
        intent: "Hosting check",
        summary: "Existing analysis artifacts remain usable without HTML.",
        confidence: 1,
        reviewStacks: [],
        files: [],
      })}\n`,
      "utf8",
    ),
  ]);
  await store.updateRun(run.slug, run.runId, { status: "succeeded", phase: "Complete" });

  const latest = await getLatestReviewPayload(store, "example-repo-1");
  assert.equal(latest.slug, "example-repo-1");
  assert.equal(latest.runId, "run-1");
  assert.equal(latest.metadata.title, "Hosting check");
  assert.equal(latest.analysis.intent, "Hosting check");

  const specific = await getReviewPayloadForRun(store, "example-repo-1", "run-1");
  assert.equal(specific.runId, "run-1");
} finally {
  store.close();
  await rm(reviewsDir, { force: true, recursive: true });
}
