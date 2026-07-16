import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PROMPT_PATH = path.join(ROOT_DIR, "prompts", "pr-graph-agent.md");
const SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "pr-graph-analysis.schema.json");

export async function runCodexGraphAnalysis({ runDir }) {
  await mkdir(runDir, { recursive: true });

  const basePrompt = await readFile(PROMPT_PATH, "utf8");
  const prompt = `${basePrompt}

## Input

You are running in a directory containing:

- metadata.json
- diff.patch

Read those files. Do not modify files. Generate the PR graph analysis as your
final answer.
`;

  const promptPath = path.join(runDir, "analysis-prompt.md");
  const rawOutputPath = path.join(runDir, "analysis.raw.json");
  const analysisPath = path.join(runDir, "analysis.json");

  await writeFile(promptPath, prompt, "utf8");

  await runCodexExec({
    cwd: runDir,
    prompt,
    outputPath: rawOutputPath,
  });

  const rawOutput = await readFile(rawOutputPath, "utf8");
  const analysis = parseJsonObject(rawOutput);
  validateGraphAnalysis(analysis);

  await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");

  return {
    analysis,
    analysisPath,
    promptPath,
    rawOutputPath,
  };
}

async function runCodexExec({ cwd, prompt, outputPath }) {
  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--cd",
    cwd,
    "--color",
    "never",
    "--output-schema",
    SCHEMA_PATH,
    "--output-last-message",
    outputPath,
    "-",
  ];

  await new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start codex: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
      reject(new Error(`codex exec failed with exit code ${code}${details ? `:\n${details}` : ""}`));
    });

    child.stdin.end(prompt);
  });
}

function parseJsonObject(text) {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    throw new Error("Codex did not return a JSON object.");
  }
}

function validateGraphAnalysis(analysis) {
  if (analysis?.schemaVersion !== "pr-graph-analysis/v1") {
    throw new Error("analysis.json has an invalid or missing schemaVersion.");
  }

  if (!Array.isArray(analysis.nodes) || analysis.nodes.length === 0) {
    throw new Error("analysis.json must contain at least one node.");
  }

  const nodeIds = new Set();

  for (const node of analysis.nodes) {
    if (!node?.id || nodeIds.has(node.id)) {
      throw new Error(`analysis.json contains a missing or duplicate node id: ${node?.id || "<missing>"}`);
    }
    nodeIds.add(node.id);
  }

  for (const edge of analysis.edges || []) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`analysis.json edge references unknown from node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`analysis.json edge references unknown to node: ${edge.to}`);
    }
  }

  for (const edge of analysis.edges || []) {
    if (!edge.comment) {
      throw new Error(`analysis.json edge is missing comment: ${edge.from} -> ${edge.to}`);
    }
  }
}
