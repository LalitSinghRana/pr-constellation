import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import esbuild from "esbuild";
import postcss from "postcss";

const DASHBOARD_APP_ENTRY = fileURLToPath(new URL("./dashboard-app.jsx", import.meta.url));
const DASHBOARD_STYLES_ENTRY = fileURLToPath(new URL("./dashboard.css", import.meta.url));
const SOURCE_DIR = fileURLToPath(new URL(".", import.meta.url));

let assetsPromise;

export async function buildDashboardAssets({ fresh = false } = {}) {
  if (fresh || !assetsPromise) {
    assetsPromise = Promise.all([
      esbuild.build({
        entryPoints: [DASHBOARD_APP_ENTRY],
        bundle: true,
        write: false,
        format: "iife",
        globalName: "PrReviewDashboard",
        target: "es2020",
        jsx: "automatic",
        plugins: [aliasAtPlugin()],
        logLevel: "silent",
      }),
      buildDashboardCss(),
    ]).then(([bundle, css]) => {
      const js = bundle.outputFiles[0]?.text;
      if (!js) {
        throw new Error("Failed to build dashboard bundle.");
      }
      return { css, js };
    });
  }
  return assetsPromise;
}

export async function renderDashboardHtml({
  title = "Analysis benchmark · PR Review Cockpit",
} = {}) {
  const assets = await buildDashboardAssets();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Generate and benchmark local pull request analysis runs." />
    <title>${escapeHtml(title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <style>${assets.css}</style>
  </head>
  <body>
    <div id="pr-dashboard-root"></div>
    <script>${escapeScript(assets.js)}</script>
  </body>
</html>`;
}

async function buildDashboardCss() {
  const source = await readFile(DASHBOARD_STYLES_ENTRY, "utf8");
  const result = await postcss([tailwindcss()]).process(source, {
    from: DASHBOARD_STYLES_ENTRY,
  });
  return result.css;
}

function aliasAtPlugin() {
  return {
    name: "dashboard-alias-at",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        if (args.path === "@/lib/utils") {
          return { path: path.join(SOURCE_DIR, "lib/utils.js") };
        }
        return { path: path.join(SOURCE_DIR, args.path.slice(2)) };
      });
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeScript(value) {
  return String(value).replaceAll("</script", "<\\/script");
}
