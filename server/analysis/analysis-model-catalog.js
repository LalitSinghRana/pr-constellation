import { spawn } from "node:child_process";
import {
  createAnalysisCatalog,
  parseCodexModelCatalog,
  resolveProviderCatalogModels,
} from "../../shared/analysis-models.js";

const LIST_MODELS_TIMEOUT_MS = 8_000;

export async function loadAnalysisCatalog({ listCodexModels = listCodexModelsFromCli } = {}) {
  const codexDiscovered = await listCodexModels().catch(() => []);
  const models = resolveProviderCatalogModels("codex", codexDiscovered);
  return createAnalysisCatalog(models);
}

export async function listCodexModelsFromCli({
  spawnChild = spawn,
  timeoutMs = LIST_MODELS_TIMEOUT_MS,
} = {}) {
  try {
    const stdout = await runCommand(spawnChild, ["codex", ["debug", "models"]], timeoutMs);
    const models = parseCodexModelCatalog(stdout);
    if (models.length > 0) return models;
  } catch {
    // The refresh can fail offline. The catalog shipped with the CLI is still current.
  }
  const stdout = await runCommand(
    spawnChild,
    ["codex", ["debug", "models", "--bundled"]],
    timeoutMs,
  );
  return parseCodexModelCatalog(stdout);
}

function runCommand(spawnChild, argv, timeoutMs) {
  const [command, args] = argv;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnChild(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Timed out listing models after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      finish(new Error(stderr.trim() || `Model listing failed with exit code ${code}.`));
    });
  });
}
