import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadReviewContext } from "../review/review-context.js";

test("review context uses a numeric PR number for persisted review data", async (context) => {
  const reviewRoot = await mkdtemp(path.join(os.tmpdir(), "prc-review-context-"));
  context.after(() => rm(reviewRoot, { force: true, recursive: true }));
  const slug = "gh-7-example-3-app-5003";
  const runId = "2026-08-09T22-37-28-314Z-782a4007";
  const runDirectory = path.join(reviewRoot, slug, runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    path.join(runDirectory, "metadata.json"),
    JSON.stringify({
      headRefOid: "614342d71c5fa9b5e2f5190834e2ce2c0c938dde",
      url: "https://github.com/example/app/pull/5003",
    }),
  );

  const review = await loadReviewContext(slug, { reviewRoot });

  assert.equal(review.number, 5003);
  assert.equal(typeof review.number, "number");
});
