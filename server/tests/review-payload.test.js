import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../analysis/run-store.js";
import {
  getLatestReviewPayload,
  getReviewPayloadForRun,
} from "../review/review-payload-service.js";

const reviewsDir = await mkdtemp(path.join(os.tmpdir(), "pr-review-payload-"));
let clockMs = Date.parse("2026-08-13T12:00:00.000Z");
const store = new RunStore({
  reviewsDir,
  clock: () => {
    clockMs += 1000;
    return new Date(clockMs);
  },
});

try {
  const older = await store.createRun({
    runId: "run-1",
    url: "https://github.com/example/repo/pull/1",
    owner: "example",
    repo: "repo",
    number: 1,
    slug: "example-repo-1",
    title: "Older",
    headSha: "aaa",
    baseSha: "bbb",
  });
  const newer = await store.createRun({
    runId: "run-2",
    url: "https://github.com/example/repo/pull/1",
    owner: "example",
    repo: "repo",
    number: 1,
    slug: "example-repo-1",
    title: "Newer",
    headSha: "ccc",
    baseSha: "bbb",
  });

  await writeRunArtifacts(store.getRunDir(older.slug, older.runId), {
    title: "Older analysis",
  });
  await store.updateRun(older.slug, older.runId, { status: "succeeded", phase: "Complete" });

  await writeRunArtifacts(store.getRunDir(newer.slug, newer.runId), {
    title: "Newer analysis",
  });
  await store.updateRun(newer.slug, newer.runId, { status: "succeeded", phase: "Complete" });

  const latest = await getLatestReviewPayload(store, "example-repo-1");
  assert.equal(latest.runId, "run-2");
  assert.equal(latest.analysis.intent, "Newer analysis");
  assert.match(latest.diff, /const value = 2/);

  const specific = await getReviewPayloadForRun(store, "example-repo-1", "run-1");
  assert.equal(specific.runId, "run-1");
  assert.equal(specific.analysis.intent, "Older analysis");

  await assert.rejects(() => getReviewPayloadForRun(store, "example-repo-1", "missing"), {
    code: "REVIEW_NOT_FOUND",
  });

  const orphanSlug = "orphan-repo-9";
  const orphan = await store.createRun({
    runId: "run-orphan",
    url: "https://github.com/example/orphan/pull/9",
    owner: "example",
    repo: "orphan",
    number: 9,
    slug: orphanSlug,
    title: "Orphan",
    headSha: "ddd",
    baseSha: "eee",
  });
  await store.updateRun(orphan.slug, orphan.runId, { status: "succeeded", phase: "Complete" });
  await assert.rejects(() => getLatestReviewPayload(store, orphanSlug), {
    code: "REVIEW_NOT_FOUND",
  });

  assert.equal(await store.getLatestSucceededReviewRun(orphanSlug), null);
  assert.equal((await store.getLatestSucceededReviewRun("example-repo-1"))?.runId, "run-2");
} finally {
  store.close();
}

async function writeRunArtifacts(runDir, { title }) {
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
        title,
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
        intent: title,
        summary: `${title} summary`,
        confidence: 1,
        reviewStacks: [],
        files: [],
      })}\n`,
      "utf8",
    ),
  ]);
}
