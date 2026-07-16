import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import diff2html from "diff2html";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const GRAPH_APP_ENTRY = fileURLToPath(new URL("./web/graph-app.jsx", import.meta.url));
let graphAssetsPromise;

export async function renderDiffHtml({ analysis = null, pr, diff }) {
  const diffHtml = diff2html.html(diff, {
    drawFileList: true,
    matching: "lines",
    outputFormat: "side-by-side",
    renderNothingWhenEmpty: false,
    synchronisedScroll: true,
  });

  const diff2htmlCss = await readFile(require.resolve("diff2html/bundles/css/diff2html.min.css"), "utf8");
  const graphAssets = analysis ? await getGraphAssets() : null;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(pr.title)} · PR #${escapeHtml(String(pr.number))}</title>
    <style>
${diff2htmlCss}
${graphAssets?.css || ""}
      :root {
        color-scheme: light;
        --page-bg: #f6f8fa;
        --panel-bg: #ffffff;
        --border: #d0d7de;
        --text: #24292f;
        --muted: #57606a;
        --accent: #0969da;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--page-bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      header {
        position: sticky;
        top: 0;
        z-index: 10;
        border-bottom: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.96);
        padding: 16px 24px;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 20px;
        line-height: 1.35;
        letter-spacing: 0;
      }

      a {
        color: var(--accent);
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        color: var(--muted);
        font-size: 13px;
      }

      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 1px;
        border-top: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
        background: var(--border);
      }

      .summary-item {
        background: var(--panel-bg);
        padding: 12px 24px;
      }

      .summary-label {
        display: block;
        color: var(--muted);
        font-size: 12px;
      }

      .summary-value {
        display: block;
        margin-top: 3px;
        font-weight: 600;
      }

      .graph-section {
        border-bottom: 1px solid var(--border);
        background: #eef6f8;
        padding: 20px 24px 24px;
      }

      .graph-heading {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 12px;
      }

      .graph-heading h2 {
        margin: 0;
        font-size: 18px;
        letter-spacing: 0;
      }

      .graph-heading p {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
      }

      .graph-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 360px;
        gap: 16px;
        height: 620px;
        overflow: hidden;
      }

      .graph-canvas {
        position: relative;
        height: 100%;
        overflow: hidden;
        border: 1px solid var(--border);
        background: #ffffff;
      }

      #pr-graph-root {
        height: 100%;
      }

      .graph-node {
        width: 320px;
        min-height: 168px;
        border: 1px solid #cbd5e1;
        border-top: 4px solid var(--node-accent);
        background: #ffffff;
        box-shadow: 0 8px 22px rgba(15, 23, 42, 0.12);
        padding: 12px;
      }

      .graph-node.is-selected {
        outline: 3px solid rgba(37, 99, 235, 0.24);
      }

      .graph-node-topline,
      .graph-node-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .graph-node-kind {
        color: var(--node-accent);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }

      .graph-node-depth,
      .graph-node-footer {
        color: var(--muted);
        font-size: 11px;
      }

      .graph-node-title {
        margin-top: 8px;
        font-size: 15px;
        font-weight: 700;
        line-height: 1.3;
      }

      .graph-node-comment {
        display: -webkit-box;
        margin-top: 8px;
        overflow: hidden;
        color: #334155;
        font-size: 12px;
        line-height: 1.4;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 4;
      }

      .graph-node-footer {
        margin-top: 10px;
      }

      .graph-details {
        overflow: auto;
        height: 100%;
        border: 1px solid var(--border);
        background: #ffffff;
        padding: 16px;
      }

      .details-eyebrow {
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }

      .graph-details h2 {
        margin: 8px 0 10px;
        font-size: 18px;
        line-height: 1.3;
        letter-spacing: 0;
      }

      .graph-details h3 {
        margin: 18px 0 8px;
        font-size: 13px;
        letter-spacing: 0;
      }

      .graph-details p {
        margin: 0;
        color: #334155;
        font-size: 13px;
        line-height: 1.5;
      }

      .details-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 1px;
        margin: 16px 0 0;
        background: var(--border);
        border: 1px solid var(--border);
      }

      .details-stats div {
        background: #f8fafc;
        padding: 10px;
      }

      .details-stats dt {
        color: var(--muted);
        font-size: 11px;
      }

      .details-stats dd {
        margin: 3px 0 0;
        font-weight: 700;
      }

      .edge-list,
      .evidence-list {
        display: grid;
        gap: 8px;
      }

      .edge-list-item,
      .evidence-item {
        width: 100%;
        border: 1px solid #dbe3ea;
        background: #f8fafc;
        color: var(--text);
        cursor: pointer;
        padding: 10px;
        text-align: left;
      }

      .edge-list-item:hover,
      .evidence-item:hover {
        border-color: #93c5fd;
        background: #eff6ff;
      }

      .edge-list-item span,
      .edge-list-item strong,
      .evidence-file,
      .evidence-hunk,
      .evidence-item code {
        display: block;
      }

      .edge-list-item span,
      .evidence-file {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.35;
      }

      .edge-list-item strong {
        margin-top: 4px;
        font-size: 13px;
      }

      .evidence-hunk {
        margin-top: 4px;
        color: #475569;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
      }

      .evidence-item code {
        margin-top: 8px;
        color: #0f172a;
        font-size: 12px;
        white-space: normal;
      }

      .edge-endpoints {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      .edge-endpoints div {
        border: 1px solid #dbe3ea;
        background: #f8fafc;
        padding: 10px;
      }

      .edge-endpoints span {
        display: block;
        color: var(--muted);
        font-size: 11px;
      }

      .edge-endpoints strong {
        display: block;
        margin-top: 4px;
        font-size: 13px;
      }

      .react-flow__edge-textbg {
        fill: #ffffff;
      }

      .react-flow__edge-text {
        font-size: 11px;
        font-weight: 700;
      }

      main {
        padding: 24px;
      }

      .diff-shell {
        border: 1px solid var(--border);
        background: var(--panel-bg);
      }

      .d2h-file-list-wrapper {
        border-bottom: 1px solid var(--border);
      }

      .d2h-file-header {
        position: sticky;
        top: 74px;
        z-index: 5;
      }

      .d2h-code-side-line,
      .d2h-code-line {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }

      .is-diff-highlighted {
        outline: 3px solid #f59e0b;
        outline-offset: 2px;
      }

      @media (max-width: 980px) {
        .graph-layout {
          grid-template-columns: 1fr;
        }

        .graph-details {
          min-height: 360px;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1><a href="${escapeAttribute(pr.url)}">${escapeHtml(pr.title)}</a></h1>
      <div class="meta">
        <span>${escapeHtml(pr.state)}</span>
        <span>${escapeHtml(pr.baseRefName)} <- ${escapeHtml(pr.headRefName)}</span>
        <span>${escapeHtml(pr.author?.login || "unknown author")}</span>
      </div>
    </header>
    <section class="summary" aria-label="Pull request summary">
      <div class="summary-item">
        <span class="summary-label">Files</span>
        <span class="summary-value">${escapeHtml(String(pr.changedFiles ?? pr.files?.length ?? 0))}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Additions</span>
        <span class="summary-value">+${escapeHtml(String(pr.additions ?? 0))}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Deletions</span>
        <span class="summary-value">-${escapeHtml(String(pr.deletions ?? 0))}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">PR</span>
        <span class="summary-value">#${escapeHtml(String(pr.number))}</span>
      </div>
    </section>
    ${analysis ? renderGraphSection(analysis, graphAssets) : ""}
    <main>
      <div class="diff-shell">
${diffHtml}
      </div>
    </main>
  </body>
</html>`;
}

async function getGraphAssets() {
  graphAssetsPromise ||= buildGraphAssets();
  return graphAssetsPromise;
}

async function buildGraphAssets() {
  const [reactFlowCss, bundle] = await Promise.all([
    readFile(require.resolve("@xyflow/react/dist/style.css"), "utf8"),
    esbuild.build({
      entryPoints: [GRAPH_APP_ENTRY],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "PrReviewGraph",
      target: "es2020",
      jsx: "automatic",
      logLevel: "silent",
    }),
  ]);

  const js = bundle.outputFiles[0]?.text;

  if (!js) {
    throw new Error("Failed to build graph webview bundle.");
  }

  return {
    css: reactFlowCss,
    js,
  };
}

function renderGraphSection(analysis, graphAssets) {
  return `<section class="graph-section" aria-label="Logical PR change graph">
      <div class="graph-heading">
        <h2>Logical Change Graph</h2>
        <p>${escapeHtml(analysis.nodes.length)} nodes · ${escapeHtml(analysis.edges.length)} edges</p>
      </div>
      <script id="pr-analysis-data" type="application/json">${serializeJsonForScript(analysis)}</script>
      <div id="pr-graph-root"></div>
      <script>${escapeScript(graphAssets.js)}</script>
    </section>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function serializeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeScript(value) {
  return String(value).replace(/<\/script/gi, "<\\/script");
}
