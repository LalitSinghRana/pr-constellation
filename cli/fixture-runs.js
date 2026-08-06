import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDiffInventory } from "../workflows/pr-review-analysis/03-build-diff-inventory/diff-inventory.js";
import {
  computeStackTreeMetrics,
  runCodexReviewAnalysis,
} from "../workflows/pr-review-analysis/07-run-retry-loop/codex-agent.js";
import { renderDiffHtml } from "../src/review/render.js";
import { publishStableReview } from "./review-run.js";
import { RunStore } from "./run-store.js";

const FIXTURES_DIR = fileURLToPath(new URL("../.context/split-fixtures/", import.meta.url));

// Frozen, SHA-pinned PR diffs used to gate Review Stack grouping. Kept here
// so this page can trigger the real pipeline
// against the same inputs instead of a live GitHub fetch, which would drift
// as the underlying PRs merge or change.
// realPr fields are frozen copies of `gh pr view --json number,title,author,state`
// for the underlying PR(s), fetched once. Fixture A combines 3 stacked PRs by
// the same author, so its title/number represent the combined stack (#197 is
// primary), not a single GitHub PR.
export const FIXTURE_DEFINITIONS = [
  {
    key: "a",
    slug: "fixture-a",
    kind: "Human benchmark",
    purpose: "A human hand-split this into 3 real PRs: core token contracts, then a theme generator, then a typed example. Ground truth for whether the tool rediscovers the same 3-way split, including sub-structure inside the 58-file first PR.",
    patches: ["pr-197.patch", "pr-198.patch", "pr-199.patch"],
    realPr: {
      author: "leonardowf",
      number: 197,
      state: "OPEN",
      title: "[Design tokens 1-3/3] Component token contracts + theme generator + typed example (combined #197-#199)",
    },
    referenceUrls: [
      "https://github.com/PicnicSupermarket/picnic-page-platform-modules/pull/197",
      "https://github.com/PicnicSupermarket/picnic-page-platform-modules/pull/198",
      "https://github.com/PicnicSupermarket/picnic-page-platform-modules/pull/199",
    ],
  },
  {
    key: "b",
    slug: "fixture-b",
    kind: "Shared-node case",
    purpose: "Two features ship together over a shared search-history-item component. Tests whether the tool finds the articulation point and gives it its own stack instead of merging both features into one blob.",
    patches: ["pr-4919.patch"],
    realPr: {
      author: "omartornaghi-teampicnic",
      number: 4919,
      state: "OPEN",
      title: "STO-15733 Add suggestions and recommendations to search page",
    },
    referenceUrls: ["https://github.com/PicnicSupermarket/picnic-store-config/pull/4919"],
  },
  {
    key: "c",
    slug: "fixture-c",
    kind: "Vertical chain",
    purpose: "All-new component: leaf -> interaction hook -> parent -> util -> mocks -> stories -> tests -> example page. Tests whether the tool recognizes one cohesive feature instead of forcing an arbitrary split.",
    patches: ["pr-4876.patch"],
    realPr: {
      author: "dawsonquadros-sketch",
      number: 4876,
      state: "OPEN",
      title: "STO-15201 Add Variant Pill Selector Component",
    },
    referenceUrls: ["https://github.com/PicnicSupermarket/picnic-store-config/pull/4876"],
  },
  {
    key: "d",
    slug: "fixture-d",
    kind: "Negative control",
    purpose: "76 changed files, but only 2 are real code; ~70 are regenerated snapshot JSON. Correct output is roughly 2 stacks (code, snapshots). If the tool proposes 5-6 stacks, it is over-splitting on file count alone and should NOT be trusted.",
    patches: ["pr-4951.patch"],
    realPr: {
      author: "polsotos-picnic",
      number: 4951,
      state: "OPEN",
      title: "STO-10919 Replace all usages of user_blacklisted_articles calcite table",
    },
    referenceUrls: ["https://github.com/PicnicSupermarket/picnic-store-config/pull/4951"],
  },
];

export function findFixtureDefinition(key) {
  const fixture = FIXTURE_DEFINITIONS.find((candidate) => candidate.key === key);
  if (!fixture) {
    const error = new Error(`Unknown fixture "${key}".`);
    error.statusCode = 404;
    throw error;
  }
  return fixture;
}

async function loadFixtureDiffText(fixture) {
  const texts = await Promise.all(
    fixture.patches.map((name) => readFile(path.join(FIXTURES_DIR, name), "utf8")),
  );
  const combined = texts.map((text) => (text.endsWith("\n") ? text : `${text}\n`)).join("");
  return fixture.patches.length > 1 ? dedupeDiffBlocksByPath(combined) : combined;
}

// Fixture A concatenates 3 separately-fetched PR patches (see split-fixtures
// README: design-system/package.json is touched by both #198 and #199). A
// real single diff never touches one path twice; keep the first occurrence
// and drop the rest so the production validator's one-path-per-file
// assumption (correct for real PRs) still holds.
function dedupeDiffBlocksByPath(diffText) {
  const starts = [...diffText.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (starts.length === 0) {
    return diffText;
  }

  const seenPaths = new Set();
  const blocks = [];

  starts.forEach((start, index) => {
    const block = diffText.slice(start, starts[index + 1] ?? diffText.length);
    const header = block.slice(0, block.indexOf("\n"));
    const match = header.match(/^diff --git a\/(.*?) b\/(.*)$/);
    const filePath = match ? match[2] : header;

    if (seenPaths.has(filePath)) {
      return;
    }
    seenPaths.add(filePath);
    blocks.push(block);
  });

  return blocks.join("");
}

function buildFixtureMetadata(fixture, diffInventory) {
  return {
    additions: diffInventory.files.reduce((total, file) => total + (file.addedLines || 0), 0),
    author: { login: fixture.realPr.author },
    deletions: diffInventory.files.reduce((total, file) => total + (file.deletedLines || 0), 0),
    changedFiles: diffInventory.files.length,
    files: diffInventory.files.map((file) => ({ path: file.path })),
    number: fixture.realPr.number,
    state: fixture.realPr.state,
    title: fixture.realPr.title,
    url: fixture.referenceUrls[0],
  };
}

// Fast synchronous half: creates the run record and frozen inputs, then
// returns immediately with a `completion` promise for the slow AI half, so an
// HTTP handler can respond with the "running" record without blocking on a
// multi-minute analysis.
export async function startFixtureRun({ fixtureKey, runStore, signal }) {
  const fixture = findFixtureDefinition(fixtureKey);
  const diff = await loadFixtureDiffText(fixture);
  const diffInventory = createDiffInventory(diff);
  const metadata = buildFixtureMetadata(fixture, diffInventory);
  const runId = createRunId();

  const run = await runStore.createRun({
    number: fixture.realPr.number,
    owner: "fixtures",
    repo: fixture.key,
    runId,
    slug: fixture.slug,
    status: "running",
    title: fixture.realPr.title,
    url: fixture.referenceUrls[0],
  });

  const runDir = runStore.getRunDir(fixture.slug, runId);
  await mkdir(runDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(runDir, "diff.patch"), diff, "utf8"),
    writeFile(path.join(runDir, "diff-inventory.json"), `${JSON.stringify(diffInventory, null, 2)}\n`, "utf8"),
    writeFile(path.join(runDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
  ]);

  const completion = finishFixtureRun({ diff, diffInventory, fixture, metadata, runDir, runId, runStore, signal });

  return { completion, run };
}

async function finishFixtureRun({ diff, diffInventory, fixture, metadata, runDir, runId, runStore, signal }) {
  const stableHtmlPath = path.join(runStore.reviewsDir, fixture.slug, "index.html");

  try {
    const analysisResult = await runCodexReviewAnalysis({ runDir, signal });
    const html = await renderDiffHtml({ analysis: analysisResult.analysis, diff, pr: metadata });
    const htmlPath = path.join(runDir, "index.html");

    await writeFile(htmlPath, html, "utf8");
    await publishStableReview({ htmlPath, stableHtmlPath });

    return await runStore.updateRun(fixture.slug, runId, {
      metrics: {
        changedFiles: metadata.changedFiles,
        stackCount: analysisResult.analysis?.reviewStacks?.length ?? null,
        ...computeStackTreeMetrics({ analysis: analysisResult.analysis, inventory: diffInventory }),
      },
      status: "succeeded",
    });
  } catch (error) {
    const isCanceled = error?.name === "AbortError" || error?.code === "ABORT_ERR";

    return runStore.updateRun(fixture.slug, runId, {
      error: {
        code: isCanceled ? "FIXTURE_RUN_CANCELED" : "FIXTURE_RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
      status: isCanceled ? "canceled" : "failed",
    });
  }
}

function createRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// One in-flight run per fixture key, each with its own AbortController so it
// can be canceled from the UI; a second trigger while one is running is
// rejected rather than queued, since these are manual one-off benchmark runs.
export function createFixtureRunService({ reviewsDir }) {
  const runStore = new RunStore({ reviewsDir });
  const activeRuns = new Map();

  async function listFixtures() {
    const manifests = await runStore.scanRuns();
    const runsBySlug = new Map();

    for (const manifest of manifests) {
      if (!manifest.slug.startsWith("fixture-")) {
        continue;
      }
      const runs = runsBySlug.get(manifest.slug) || [];
      runs.push(manifest);
      runsBySlug.set(manifest.slug, runs);
    }

    return FIXTURE_DEFINITIONS.map((fixture) => ({
      isRunning: activeRuns.has(fixture.key),
      key: fixture.key,
      kind: fixture.kind,
      patches: fixture.patches,
      purpose: fixture.purpose,
      realPr: fixture.realPr,
      referenceUrls: fixture.referenceUrls,
      runs: runsBySlug.get(fixture.slug) || [],
      slug: fixture.slug,
    }));
  }

  async function triggerRun(key) {
    const fixture = findFixtureDefinition(key);
    if (activeRuns.has(fixture.key)) {
      const error = new Error(`Fixture "${fixture.key}" already has a run in progress.`);
      error.statusCode = 409;
      throw error;
    }

    const controller = new AbortController();
    const { completion, run } = await startFixtureRun({
      fixtureKey: key,
      runStore,
      signal: controller.signal,
    });

    activeRuns.set(fixture.key, { controller, runId: run.runId });
    completion.catch(() => {}).finally(() => {
      if (activeRuns.get(fixture.key)?.runId === run.runId) {
        activeRuns.delete(fixture.key);
      }
    });

    return run;
  }

  async function stopRun(key) {
    const fixture = findFixtureDefinition(key);
    const active = activeRuns.get(fixture.key);
    if (!active) {
      const error = new Error(`Fixture "${fixture.key}" has no run in progress.`);
      error.statusCode = 404;
      throw error;
    }

    active.controller.abort(new Error("Canceled from the fixtures page."));
    return { key: fixture.key, runId: active.runId };
  }

  return { listFixtures, stopRun, triggerRun };
}
