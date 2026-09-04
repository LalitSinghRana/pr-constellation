import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGitHubPrUrl } from "../../analysis-worker/workflow/02-fetch-pr/github.js";
import {
  ANALYSIS_RETENTION_AFTER_CLOSE_MS,
  ANALYSIS_RETENTION_TERMINAL_RUN_MS,
} from "../../shared/analysis-retention.js";
import { DashboardService } from "../analysis/dashboard-service.js";

const now = new Date("2026-08-20T12:00:00.000Z");

test("expired merged analysis is deleted with its slug directory and drafts", async (context) => {
  const { parsed, reviewsDir, service, url } = await createService(context, "prc-analysis-gc-");
  await createSucceededRun(service, {
    number: 42,
    runId: "run-old",
    slug: parsed.slug,
    title: "Old analysis",
    url,
  });
  const drafts = [];
  const deleted = await service.deleteExpiredAnalysis({
    deleteDraft: (slug) => drafts.push(slug),
    now,
    queueItems: [mergedItem(url, ANALYSIS_RETENTION_AFTER_CLOSE_MS)],
  });

  assert.deepEqual(deleted.deletedSlugs, [parsed.slug]);
  assert.deepEqual(drafts, [parsed.slug]);
  await assert.rejects(() => service.store.readRun(parsed.slug, "run-old"), { code: "ENOENT" });
  await assert.rejects(() => access(path.join(reviewsDir, parsed.slug)), { code: "ENOENT" });
});

test("inbox retention deletes merged analysis after seven days and keeps an open pull request", async (context) => {
  const { service } = await createService(context, "prc-analysis-gc-sync-");
  const mergedUrl = "https://github.com/example/widgets/pull/42";
  const openUrl = "https://github.com/example/widgets/pull/9";
  const merged = parseGitHubPrUrl(mergedUrl);
  const open = parseGitHubPrUrl(openUrl);
  await createSucceededRun(service, {
    number: 42,
    runId: "run-merged",
    slug: merged.slug,
    title: "Merged",
    url: mergedUrl,
  });
  await createSucceededRun(service, {
    number: 9,
    runId: "run-open",
    slug: open.slug,
    title: "Open",
    url: openUrl,
  });

  const deleted = await service.deleteExpiredAnalysis({
    now,
    queueItems: [
      mergedItem(mergedUrl, ANALYSIS_RETENTION_AFTER_CLOSE_MS),
      {
        state: "OPEN",
        updatedAt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1_000).toISOString(),
        url: openUrl,
      },
    ],
  });

  assert.deepEqual(deleted.deletedSlugs, [merged.slug]);
  assert.equal((await service.store.readRun(open.slug, "run-open")).runId, "run-open");
});

test("recently merged analysis is kept", async (context) => {
  const { parsed, service, url } = await createService(context, "prc-analysis-gc-keep-");
  await createSucceededRun(service, {
    number: 9,
    runId: "run-fresh",
    slug: parsed.slug,
    title: "Fresh",
    url,
  });
  const deleted = await service.deleteExpiredAnalysis({
    now,
    queueItems: [mergedItem(url, 2 * 24 * 60 * 60 * 1_000)],
  });
  assert.deepEqual(deleted.deletedSlugs, []);
  assert.equal((await service.store.readRun(parsed.slug, "run-fresh")).runId, "run-fresh");
});

test("queued analysis is skipped until the next sync", async (context) => {
  const { parsed, service, url } = await createService(context, "prc-analysis-gc-queued-");
  await service.store.createRun({
    number: 42,
    owner: "example",
    repo: "widgets",
    runId: "run-queued",
    slug: parsed.slug,
    title: "Queued",
    url,
  });
  const deleted = await service.deleteExpiredAnalysis({
    now,
    queueItems: [mergedItem(url, ANALYSIS_RETENTION_AFTER_CLOSE_MS)],
  });
  assert.deepEqual(deleted.deletedSlugs, []);
  assert.equal((await service.store.readRun(parsed.slug, "run-queued")).status, "queued");
});

test("deletes two-day-old failed runs and extra successes, keeping the latest success for an open PR", async (context) => {
  const { parsed, service, url } = await createService(context, "prc-analysis-gc-terminal-");
  const twoDaysAgo = new Date(
    now.getTime() - ANALYSIS_RETENTION_TERMINAL_RUN_MS - 60 * 60 * 1_000,
  ).toISOString();
  await createTerminalRun(service, {
    completedAt: twoDaysAgo,
    number: 42,
    runId: "run-old-success",
    slug: parsed.slug,
    status: "succeeded",
    title: "Old success",
    url,
  });
  await createTerminalRun(service, {
    completedAt: twoDaysAgo,
    number: 42,
    runId: "run-failed",
    slug: parsed.slug,
    status: "failed",
    title: "Failed",
    url,
  });
  await createTerminalRun(service, {
    completedAt: now.toISOString(),
    number: 42,
    runId: "run-latest-success",
    slug: parsed.slug,
    status: "succeeded",
    title: "Latest success",
    url,
  });

  const deleted = await service.deleteExpiredAnalysis({
    now,
    queueItems: [
      {
        done: false,
        state: "OPEN",
        updatedAt: now.toISOString(),
        url,
      },
    ],
  });

  assert.deepEqual(deleted.deletedSlugs, []);
  assert.equal(
    (await service.store.readRun(parsed.slug, "run-latest-success")).runId,
    "run-latest-success",
  );
  await assert.rejects(() => service.store.readRun(parsed.slug, "run-failed"), { code: "ENOENT" });
  await assert.rejects(() => service.store.readRun(parsed.slug, "run-old-success"), {
    code: "ENOENT",
  });
});

test("deletes remaining analysis seven days after the inbox row was marked done", async (context) => {
  const { parsed, reviewsDir, service, url } = await createService(
    context,
    "prc-analysis-gc-done-",
  );
  await createSucceededRun(service, {
    number: 42,
    runId: "run-done",
    slug: parsed.slug,
    title: "Done",
    url,
  });
  const deleted = await service.deleteExpiredAnalysis({
    now,
    queueItems: [
      {
        done: true,
        doneAt: new Date(now.getTime() - ANALYSIS_RETENTION_AFTER_CLOSE_MS).toISOString(),
        state: "OPEN",
        updatedAt: now.toISOString(),
        url,
      },
    ],
  });
  assert.deepEqual(deleted.deletedSlugs, [parsed.slug]);
  await assert.rejects(() => service.store.readRun(parsed.slug, "run-done"), { code: "ENOENT" });
  await assert.rejects(() => access(path.join(reviewsDir, parsed.slug)), { code: "ENOENT" });
});

async function createService(context, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(root, { force: true, recursive: true }));
  const reviewsDir = path.join(root, ".reviews");
  const url = "https://github.com/example/widgets/pull/42";
  const service = new DashboardService({
    configuration: {
      defaultModel: "gpt-fixture",
      models: ["gpt-fixture"],
      reasoningEfforts: ["low"],
    },
    now: () => now,
    projectRoot: root,
    reviewsDir,
    runExecutor: async () => {
      throw new Error("analysis should not start");
    },
  });
  await service.initialize();
  context.after(() => service.close());
  return { parsed: parseGitHubPrUrl(url), reviewsDir, service, url };
}

async function createSucceededRun(service, { number, runId, slug, title, url }) {
  await createTerminalRun(service, {
    completedAt: now.toISOString(),
    number,
    runId,
    slug,
    status: "succeeded",
    title,
    url,
  });
}

async function createTerminalRun(
  service,
  { completedAt, number, runId, slug, status, title, url },
) {
  await service.store.createRun({
    number,
    owner: "example",
    repo: "widgets",
    runId,
    slug,
    title,
    url,
  });
  await service.store.updateRun(slug, runId, {
    status,
    timestamps: { completedAt },
  });
}

function mergedItem(url, ageMs) {
  const expiredAt = new Date(now.getTime() - ageMs).toISOString();
  return {
    mergedAt: expiredAt,
    state: "MERGED",
    updatedAt: expiredAt,
    url,
  };
}
