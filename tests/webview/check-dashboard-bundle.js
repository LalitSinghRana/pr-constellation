import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildDashboardAssets,
  renderDashboardHtml,
} from "../../src/dashboard-render.js";

const [assets, html, appSource, styles] = await Promise.all([
  buildDashboardAssets({ fresh: true }),
  renderDashboardHtml(),
  readFile(new URL("../../src/dashboard-app.jsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/dashboard.css", import.meta.url), "utf8"),
]);

for (const marker of [
  "pr-dashboard-root",
  "Analysis benchmark",
  "Generate a new analysis",
  "Run all efforts",
  "Timing breakdown",
  "Refresh from GitHub",
  "Run all efforts",
  "Analysis batch",
  "Cancel batch",
  "Cancel run",
  "Delete batch",
  "Delete run",
  "Open graph",
]) {
  assert.match(html, new RegExp(marker));
}

assert.ok(assets.js.length > 100_000);
assert.ok(assets.css.length > 10_000);
assert.match(assets.css, /\.bg-popover\s*\{\s*background-color: var\(--popover\)/);
assert.match(
  assets.css,
  /\.text-popover-foreground\s*\{\s*color: var\(--popover-foreground\)/,
);
assert.match(
  assets.css,
  /\.focus\\:bg-accent:focus\s*\{\s*background-color: var\(--accent\)/,
);
assert.match(appSource, /from "\.\/components\/ui\/input\.jsx"/);
assert.match(appSource, /from "\.\/components\/ui\/alert-dialog\.jsx"/);
assert.match(appSource, /from "\.\/components\/ui\/progress\.jsx"/);
assert.match(appSource, /from "\.\/components\/ui\/select\.jsx"/);
assert.match(appSource, /from "\.\/dashboard-run-groups\.js"/);
assert.match(appSource, /reasoningEfforts\.map\(formatReasoningEffort\)/);
assert.match(appSource, /model:\s*selectedModel/);
assert.match(appSource, /modelProviders=\{dashboard\.configuration\?\.modelProviders/);
assert.match(
  appSource,
  /Claude \$\{titleCase\(family\)\} \$\{major\}\.\$\{minor\}/,
);
assert.match(appSource, /Claude · \$\{model\}/);
assert.match(appSource, /groupRunsForDisplay/);
assert.match(appSource, /function RunBatchGroup/);
assert.match(appSource, /data-batch-id=\{batchId\}/);
assert.match(appSource, /benchmark-run-batch-list/);
assert.match(appSource, /benchmark-run-batch-actions/);
assert.match(appSource, /variant="destructive"/);
assert.match(appSource, /Cancel analysis batch/);
assert.match(appSource, /Cancel analysis run/);
assert.match(appSource, /function DeleteHistoryButton/);
assert.match(appSource, /Delete permanently/);
assert.match(appSource, /\/batches\/\$\{encodeURIComponent\(batchId\)\}\/cancel/);
assert.match(appSource, /\/batches\/\$\{encodeURIComponent\(batchId\)\}\/rerun/);
assert.match(
  appSource,
  /\/runs\/\$\{encodeURIComponent\(prSlug\)\}\/\$\{encodeURIComponent\(runId\)\}\/cancel/,
);
assert.match(appSource, /method:\s*"POST"/);
assert.match(appSource, /method:\s*"DELETE"/);
assert.match(appSource, /body:\s*JSON\.stringify\(\{\s*model:\s*selectedModel\s*\}\)/);
assert.match(appSource, /disabled=\{Boolean\(mutation\)\}/);
assert.equal(
  [...appSource.matchAll(/const \[open, setOpen\] = useState\(false\);/g)].length,
  2,
);
assert.doesNotMatch(appSource, /API est\.|formatRunCost|runCost|batchCost/);
assert.match(appSource, /reasoningEffortLabel/);
assert.match(appSource, /metrics\?\.batchId/);
assert.match(appSource, /buildRunComparison/);
assert.match(appSource, /findPreviousComparableRun/);
assert.match(appSource, /if \(batchIndex === 0\) \{\s*return null;/);
assert.match(appSource, /runInputFingerprint\(candidate\) === inputFingerprint/);
assert.match(appSource, /modelLabel\(candidate\) === modelLabel\(run\)/);
assert.match(
  appSource,
  /reasoningEffortLabel\(candidate\) === reasoningEffortLabel\(run\)/,
);
assert.match(appSource, /inputFingerprint !== runInputFingerprint\(baseline\)/);
assert.match(appSource, /refresh:\s*true/);
assert.match(appSource, /target="_blank"/);
assert.match(appSource, /run\.timings\?\.totalDurationMs/);
assert.match(appSource, /run\?\.timestamps\?\.\[key\]/);
assert.match(styles, /\.benchmark-waterfall/);
assert.match(styles, /\.benchmark-model-trigger/);
assert.match(styles, /\.benchmark-run-batch-header/);
assert.match(styles, /\.benchmark-run-batch-active/);
assert.match(styles, /\.benchmark-run-batch-actions/);
assert.match(styles, /\.benchmark-cancel-button/);
assert.match(styles, /\.benchmark-delete-button/);
assert.doesNotMatch(styles, /\.benchmark-run-cost/);
assert.match(styles, /\.benchmark-comparison-faster/);
assert.match(styles, /@media/);

console.log("dashboard bundle checks passed");
