import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAbortError, throwIfAborted } from "../abort.js";
import {
  createChildProcessTerminator,
  USE_DETACHED_PROCESS_GROUP,
} from "../child-process-termination.js";
import { addUsage, emptyUsage, normalizeUsage } from "./usage.js";

const REVIEW_TREES_SCHEMA_PATH = fileURLToPath(
  new URL("../04-generate-candidate-analysis/03-create-review-trees/schema.json", import.meta.url),
);
const CODEX_EXEC_TIMEOUT_MS = Number(process.env.PRC_CODEX_TIMEOUT_MS || 900000);
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;

export function resolveCodexExecutionConfig({ env = process.env, model, reasoningEffort } = {}) {
  return {
    model: resolveSelectedString({
      envValue: env.PRC_CODEX_MODEL,
      label: "model",
      value: model,
    }),
    reasoningEffort: resolveSelectedString({
      envValue: env.PRC_CODEX_REASONING_EFFORT,
      label: "reasoningEffort",
      value: reasoningEffort,
    }),
  };
}

export function buildCodexProbeArgs({ cwd, model, reasoningEffort }) {
  return [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--cd",
    cwd,
    "--color",
    "never",
    ...(model ? ["--model", model] : []),
    ...(reasoningEffort
      ? ["--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
      : []),
    "-",
  ];
}

export function buildCodexExecArgs({
  cwd,
  model,
  outputPath,
  reasoningEffort,
  schemaPath = REVIEW_TREES_SCHEMA_PATH,
}) {
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--sandbox",
    "read-only",
    "--cd",
    cwd,
    "--color",
    "never",
    ...(model ? ["--model", model] : []),
    ...(reasoningEffort
      ? ["--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
      : []),
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-",
  ];
}

export function parseCodexJsonUsage(stdout) {
  const usage = emptyUsage();

  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.type === "turn.completed") {
      addUsage(usage, normalizeUsage(event.usage));
    }
  }

  return usage;
}

export async function runCodexExec({
  cwd,
  model,
  prompt,
  outputPath,
  reasoningEffort,
  schemaPath = REVIEW_TREES_SCHEMA_PATH,
  signal,
}) {
  throwIfAborted(signal);

  const args = buildCodexExecArgs({
    cwd,
    model,
    outputPath,
    reasoningEffort,
    schemaPath,
  });

  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd,
      detached: USE_DETACHED_PROCESS_GROUP,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminator = createChildProcessTerminator(child);

    let aborted = false;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      aborted = true;
      clearTimeout(timeoutTimer);
      terminator.terminate();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminator.terminate();
    }, CODEX_EXEC_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (outputExceeded) return;
      stdout += chunk;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputExceeded = true;
        clearTimeout(timeoutTimer);
        terminator.terminate();
      }
    });

    child.stderr.on("data", (chunk) => {
      if (outputExceeded) return;
      stderr += chunk;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputExceeded = true;
        clearTimeout(timeoutTimer);
        terminator.terminate();
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      if (child.pid) {
        return;
      }
      terminator.childClosed();
      if (aborted || signal?.aborted) {
        rejectOnce(createCodexAbortError(signal?.reason, stdout));
        return;
      }
      rejectOnce(createCodexExecError(`Failed to start codex: ${error.message}`, stdout));
    });

    child.on("close", async (code) => {
      clearTimeout(timeoutTimer);
      terminator.childClosed();
      await terminator.waitForTreeExit();

      if (settled) {
        return;
      }

      if (aborted || signal?.aborted) {
        rejectOnce(createCodexAbortError(signal?.reason, stdout));
        return;
      }

      if (timedOut) {
        rejectOnce(
          createCodexExecError(`codex exec timed out after ${CODEX_EXEC_TIMEOUT_MS}ms.`, stdout),
        );
        return;
      }

      if (outputExceeded) {
        rejectOnce(
          createCodexExecError(
            `codex exec exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes of process output.`,
            stdout,
          ),
        );
        return;
      }

      if (code === 0) {
        resolveOnce({
          usage: parseCodexJsonUsage(stdout),
        });
        return;
      }

      const details = summarizeCodexFailure({ stderr, stdout });
      rejectOnce(
        createCodexExecError(
          `codex exec failed with exit code ${code}${details ? `:\n${details}` : ""}`,
          stdout,
        ),
      );
    });

    child.stdin.on("error", () => {
      // Process termination is reported through the child close/error handlers.
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child.stdin.end(prompt);
  });
}

function createCodexAbortError(reason, stdout) {
  const error = createAbortError(reason);
  error.usage = parseCodexJsonUsage(stdout);
  return error;
}

function createCodexExecError(message, stdout) {
  const error = new Error(message);
  error.usage = parseCodexJsonUsage(stdout);
  return error;
}

function summarizeCodexFailure({ stderr, stdout }) {
  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
  const apiMessages = [...details.matchAll(/"message":\s*"([^"\n]+)"/g)];
  const apiMessage = apiMessages.at(-1)?.[1];

  if (apiMessage) {
    return apiMessage.replaceAll("\\n", "\n").replaceAll('\\"', '"');
  }

  return details.slice(-4000);
}

function resolveSelectedString({ envValue, label, value }) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError(`${label} must be a string when provided.`);
  }

  const explicitValue = typeof value === "string" ? value.trim() : "";
  const fallbackValue = typeof envValue === "string" ? envValue.trim() : "";
  return explicitValue || fallbackValue || undefined;
}
