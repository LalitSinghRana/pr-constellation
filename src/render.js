import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import diff2html from "diff2html";

const require = createRequire(import.meta.url);

export async function renderDiffHtml({ pr, diff }) {
  const diffHtml = diff2html.html(diff, {
    drawFileList: true,
    matching: "lines",
    outputFormat: "side-by-side",
    renderNothingWhenEmpty: false,
    synchronisedScroll: true,
  });

  const diff2htmlCss = await readFile(require.resolve("diff2html/bundles/css/diff2html.min.css"), "utf8");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(pr.title)} · PR #${escapeHtml(String(pr.number))}</title>
    <style>
${diff2htmlCss}
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
    <main>
      <div class="diff-shell">
${diffHtml}
      </div>
    </main>
  </body>
</html>`;
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
