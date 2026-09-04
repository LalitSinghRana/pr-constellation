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

test("review context falls back to GitHub metadata when no run exists", async (context) => {
  const reviewRoot = await mkdtemp(path.join(os.tmpdir(), "prc-review-context-missing-"));
  context.after(() => rm(reviewRoot, { force: true, recursive: true }));
  const slug = "gh-7-example-3-app-5003";
  const review = await loadReviewContext(slug, {
    fetchMetadata: async () => ({
      author: { login: "alice" },
      body: "Hello",
      headRefOid: "abc123",
      number: 5003,
      state: "OPEN",
      title: "Fallback",
      url: "https://github.com/example/app/pull/5003",
    }),
    reviewRoot,
  });

  assert.equal(review.number, 5003);
  assert.equal(review.owner, "example");
  assert.equal(review.repo, "app");
  assert.equal(review.headSha, "abc123");
  assert.equal(review.metadata.title, "Fallback");
  assert.equal(review.runId, null);
});

test("review context falls back to inbox metadata when GitHub is unavailable", async (context) => {
  const reviewRoot = await mkdtemp(path.join(os.tmpdir(), "prc-review-context-inbox-"));
  context.after(() => rm(reviewRoot, { force: true, recursive: true }));
  const slug = "gh-7-example-3-app-5003";
  const review = await loadReviewContext(slug, {
    fetchMetadata: async () => {
      throw new Error("GitHub unavailable");
    },
    loadInboxMetadata: async () => ({
      author: { login: "bob" },
      headRefOid: "def456",
      number: 5003,
      state: "OPEN",
      title: "From inbox",
      url: "https://github.com/example/app/pull/5003",
    }),
    reviewRoot,
  });

  assert.equal(review.metadata.title, "From inbox");
  assert.equal(review.headSha, "def456");
  assert.equal(review.runId, null);
});
