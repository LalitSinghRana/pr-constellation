import { spawn } from "node:child_process";
import path from "node:path";
import { createReviewRun } from "./review-run.js";

const usage = `Usage:
  prc <github-pr-url> [--open] [--no-open]

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
    help: false,
    open: false,
    prUrl: undefined,
  };

  for (const arg of args) {
    if (arg === "--") {
      continue;
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
