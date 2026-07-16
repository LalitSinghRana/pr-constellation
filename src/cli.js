import { spawn } from "node:child_process";
import path from "node:path";
import { createAnalysisRun, createReviewRun, renderExistingRun } from "./review-run.js";

const usage = `Usage:
  prc <github-pr-url> [--open] [--no-open]
  prc analyze <github-pr-url>
  prc view <run-dir> [--open]

Options:
  --open       Open the generated review HTML in the default browser.
  --no-open    Do not open the generated review HTML.
  --help       Show this help.
`;

export async function runCli(args) {
  const options = parseArgs(args);

  if (options.help) {
    console.log(usage.trimEnd());
    return;
  }

  if (options.command === "analyze") {
    if (!options.prUrl) {
      throw new Error(usage.trimEnd());
    }

    const result = await createAnalysisRun({
      prUrl: options.prUrl,
      reviewsDir: path.resolve(process.cwd(), ".reviews"),
    });

    console.log(`Analysis generated: ${result.analysisPath}`);
    console.log(`Run directory: ${result.runDir}`);
    return;
  }

  if (options.command === "view") {
    if (!options.prUrl) {
      throw new Error(usage.trimEnd());
    }

    const result = await renderExistingRun({
      runDir: path.resolve(process.cwd(), options.prUrl),
    });

    if (options.open) {
      await openFile(result.htmlPath);
    }

    console.log(`Review generated: ${result.htmlPath}`);
    if (result.analysisPath) {
      console.log(`Graph analysis used: ${result.analysisPath}`);
    }
    console.log(`Run directory: ${result.runDir}`);
    return;
  }

  if (!options.prUrl) {
    throw new Error(usage.trimEnd());
  }

  const result = await createReviewRun({
    prUrl: options.prUrl,
    reviewsDir: path.resolve(process.cwd(), ".reviews"),
  });

  if (options.open) {
    await openFile(result.htmlPath);
  }

  console.log(`Review generated: ${result.htmlPath}`);
  console.log(`Run directory: ${result.runDir}`);
}

function parseArgs(args) {
  const options = {
    command: "review",
    help: false,
    open: false,
    prUrl: undefined,
  };

  for (const arg of args) {
    if (arg === "--") {
      continue;
    } else if ((arg === "analyze" || arg === "view") && !options.prUrl && options.command === "review") {
      options.command = arg;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--open") {
      options.open = true;
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (!options.prUrl) {
      options.prUrl = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}\n\n${usage.trimEnd()}`);
    }
  }

  return options;
}

async function openFile(filePath) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  await new Promise((resolve, reject) => {
    const child = spawn(command, [filePath], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });

    child.on("error", reject);
    child.unref();
    resolve();
  });
}
