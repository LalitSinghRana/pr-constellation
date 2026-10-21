import { spawn } from "node:child_process";
import { buildCodexProbeArgs } from "../../analysis-worker/workflow/07-run-retry-loop/codex-exec.js";
import {
  analysisModelReasoningEffort,
  DEFAULT_ANALYSIS_MODEL,
  settingsAnalysisRunOptions,
} from "../../shared/analysis-models.js";
import { projectRoot } from "../runtime-config.js";

const PROBE_TIMEOUT_MS = 45_000;
const PROBE_PROMPT = 'Reply with {"ok":true} only.';

/**
 * Probe the configured default analysis agent the same way a real run does.
 */
export async function probeAnalysisAgent(options = {}) {
  const { model, provider, reasoningEffort } =
    options && typeof options === "object" && "defaultAnalysisModel" in options
      ? settingsAnalysisRunOptions(options)
      : options;
  const selected =
    typeof model === "string" && model.trim() ? model.trim() : DEFAULT_ANALYSIS_MODEL;
  return probeCodexAgent(selected, reasoningEffort);
}

function probeCodexAgent(model, reasoningEffort) {
  const selectedEffort = reasoningEffort || analysisModelReasoningEffort(model, "codex");
  const args = buildCodexProbeArgs({
    cwd: projectRoot,
    model,
    reasoningEffort: selectedEffort,
  });
  return runCliProbe({
    command: "codex",
    args,
    model,
    provider: "codex",
    stdin: PROBE_PROMPT,
  });
}

function runCliProbe({ command, args, model, provider, stdin }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: projectRoot,
        env: process.env,
        stdio: stdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        accessible: false,
        available: false,
        message: error?.message || "Codex could not be started.",
        model,
        provider,
      });
      return;
    }

    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, model, provider });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        accessible: false,
        available: true,
        message: `Codex probe timed out after ${PROBE_TIMEOUT_MS / 1_000} seconds.`,
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
          message: `${command} CLI was not found on PATH.`,
        });
        return;
      }
      finish({
        accessible: false,
        available: true,
        message: error?.message || "Codex could not be started.",
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
          message: "Codex is accessible",
        });
        return;
      }
      finish({
        accessible: false,
        available: true,
        message: details || `Codex probe failed with exit code ${code}.`,
      });
    });
  });
}
