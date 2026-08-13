import path from "node:path";
import { createAnalysisRun, createReviewRun } from "./review-run.js";

const usage = `Usage:
  prc <github-pr-url>
  prc analyze <github-pr-url>

Options:
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
    console.log(`Diff inventory generated: ${result.diffInventoryPath}`);
    console.log(`Diff summary generated: ${result.diffSummaryPath}`);
    console.log(`Judge generated: ${result.judgePath}`);
    console.log(`Run directory: ${result.runDir}`);
    return;
  }

  if (options.command === "view") {
    throw new Error(
      "prc view is no longer supported. Open http://127.0.0.1:4397/reviews/<slug>/ in the cockpit.",
    );
  }

  if (!options.prUrl) {
    throw new Error(usage.trimEnd());
  }

  const result = await createReviewRun({
    prUrl: options.prUrl,
    reviewsDir: path.resolve(process.cwd(), ".reviews"),
  });

  console.log(`Diff inventory generated: ${result.diffInventoryPath}`);
  console.log(`Diff summary generated: ${result.diffSummaryPath}`);
  console.log(`Metadata generated: ${result.metadataPath}`);
  console.log(`Run directory: ${result.runDir}`);
}

function parseArgs(args) {
  const options = {
    command: "review",
    help: false,
    prUrl: undefined,
  };

  for (const arg of args) {
    if (arg === "--") {
    } else if (
      (arg === "analyze" || arg === "view") &&
      !options.prUrl &&
      options.command === "review"
    ) {
      options.command = arg;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--open" || arg === "--no-open") {
      // Legacy flags ignored; review UI is served by the cockpit SPA.
    } else if (!options.prUrl) {
      options.prUrl = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}\n\n${usage.trimEnd()}`);
    }
  }

  return options;
}
