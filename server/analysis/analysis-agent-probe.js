import { spawn } from "node:child_process";
import { buildCursorAgentArgs } from "../../analysis-worker/workflow/07-run-retry-loop/cursor-agent.js";
import {
  analysisModelReasoningEffort,
  DEFAULT_ANALYSIS_MODEL,
  inferAnalysisProvider,
} from "../../shared/analysis-models.js";
import { projectRoot } from "../runtime-config.js";

const PROBE_TIMEOUT_MS = 45_000;
const PROBE_PROMPT = 'Reply with {"ok":true} only.';

/**
 * Probe the configured default analysis agent the same way a real run does.
 */
export async function probeAnalysisAgent({
  model = DEFAULT_ANALYSIS_MODEL,
  provider,
  reasoningEffort,
} = {}) {
  const selected =
    typeof model === "string" && model.trim() ? model.trim() : DEFAULT_ANALYSIS_MODEL;
  const selectedProvider = inferAnalysisProvider(selected, provider);
  if (selectedProvider !== "cursor") {
    return {
      accessible: false,
      available: false,
      message: `No accessibility probe for provider "${selectedProvider}" yet.`,
      model: selected,
      provider: selectedProvider,
    };
  }
  return probeCursorAgent(selected, reasoningEffort);
}

function probeCursorAgent(model, reasoningEffort) {
  const selectedEffort = reasoningEffort || analysisModelReasoningEffort(model, "cursor");
  const args = [...buildCursorAgentArgs({ model, reasoningEffort: selectedEffort }), PROBE_PROMPT];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("agent", args, {
        cwd: projectRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        accessible: false,
        available: false,
        message: error?.message || "AI agent could not be started.",
        model,
        provider: "cursor",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, model, provider: "cursor" });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        accessible: false,
        available: true,
        message: `AI agent probe timed out after ${PROBE_TIMEOUT_MS}ms.`,
      });
    }, PROBE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64_000) stdout = stdout.slice(-64_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    child.on("error", (error) => {
      if (error?.code === "ENOENT") {
        finish({
          accessible: false,
          available: false,
          message: "AI agent CLI was not found on PATH.",
        });
        return;
      }
      finish({
        accessible: false,
        available: true,
        message: error?.message || "AI agent could not be started.",
      });
    });

    child.on("close", (code) => {
      const details = [stderr, stdout]
        .filter((value) => typeof value === "string" && value.trim())
        .join("\n")
        .trim();
      if (code === 0) {
        finish({
          accessible: true,
          available: true,
          message: "AI agent is accessible",
        });
        return;
      }
      finish({
        accessible: false,
        available: true,
        message: details || `AI agent probe failed with exit code ${code}.`,
      });
    });
  });
}
