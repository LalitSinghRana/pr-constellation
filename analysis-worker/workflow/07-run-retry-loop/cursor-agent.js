import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAbortError, isAbortError, throwIfAborted } from "../abort.js";
import {
  createChildProcessTerminator,
  USE_DETACHED_PROCESS_GROUP,
} from "../child-process-termination.js";
import { emptyUsage } from "./usage.js";

const REVIEW_TREES_SCHEMA_PATH = fileURLToPath(
  new URL("../04-generate-candidate-analysis/03-create-review-trees/schema.json", import.meta.url),
);
const DEFAULT_CURSOR_AGENT_TIMEOUT_MS = 900_000;

export function buildCursorAgentArgs({ model, reasoningEffort }) {
  return [
    "--print",
    "--trust",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--sandbox",
    "enabled",
    ...(model ? ["--model", resolveCursorModelId({ model, reasoningEffort })] : []),
  ];
}

export function resolveCursorModelId({ model, reasoningEffort }) {
  const selected = typeof model === "string" ? model.trim() : "";
  if (!selected) return selected;
  const effort = typeof reasoningEffort === "string" ? reasoningEffort.trim().toLowerCase() : "";
  if (!/^grok(?:-|$)/i.test(selected)) {
    return selected;
  }
  if (!effort || /-(?:high|medium|low)$/i.test(selected)) {
    return selected;
  }
  if (effort === "high" || effort === "medium" || effort === "low") {
    return `${selected}-${effort}`;
  }
  return selected;
}

export function serializeCursorExecutor(executor) {
  let previous = Promise.resolve();
  return (options) => {
    const current = previous.then(() => executor(options));
    previous = current.catch(() => undefined);
    return current;
  };
}

export function buildCursorAgentPrompt({ prompt, schema }) {
  return `${prompt}

Return ONLY a single JSON object that validates against this JSON Schema. No markdown fences, no commentary.

<json_schema>
${JSON.stringify(schema)}
</json_schema>
`;
}

export function parseCursorAgentJson(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) {
    throw new Error("Cursor agent returned empty output.");
  }

  try {
    const document = JSON.parse(trimmed);
    const payload =
      document?.result ??
      document?.response ??
      document?.message ??
      document?.structured_output ??
      document;
    if (typeof payload === "string") {
      return parseJsonObject(payload);
    }
    if (payload && typeof payload === "object") {
      return payload;
    }
  } catch {
    // Fall through to brace extraction.
  }

  return parseJsonObject(trimmed);
}

export async function runCursorAgentExec({
  cwd,
  model,
  prompt,
  outputPath,
  reasoningEffort,
  schemaPath = REVIEW_TREES_SCHEMA_PATH,
  signal,
  timeoutMs = configuredTimeoutMs(),
}) {
  throwIfAborted(signal);
  assertTimeout(timeoutMs);

  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  throwIfAborted(signal);
  const args = buildCursorAgentArgs({ model, reasoningEffort });
  const fullPrompt = buildCursorAgentPrompt({ prompt, schema });

  return new Promise((resolve, reject) => {
    const child = spawn("agent", args, {
      cwd,
      detached: USE_DETACHED_PROCESS_GROUP,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminator = createChildProcessTerminator(child);

    let aborted = false;
    let settled = false;
    let stderr = "";
    let stdout = "";
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
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      if (child.pid) {
        return;
      }
      terminator.childClosed();
      if (aborted || signal?.aborted) {
        rejectOnce(createCursorAbortError(signal?.reason));
        return;
      }
      rejectOnce(createCursorExecError(`Failed to start agent: ${error.message}`));
    });

    child.on("close", async (code) => {
      clearTimeout(timeoutTimer);
      terminator.childClosed();
      await terminator.waitForTreeExit();

      if (settled) {
        return;
      }
      if (aborted || signal?.aborted) {
        rejectOnce(createCursorAbortError(signal?.reason));
        return;
      }
      if (timedOut) {
        rejectOnce(createCursorExecError(`agent --print timed out after ${timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n").slice(-4000);
        rejectOnce(
          createCursorExecError(
            `agent --print failed with exit code ${code}${details ? `:\n${details}` : ""}`,
          ),
        );
        return;
      }

      try {
        const structured = parseCursorAgentJson(stdout);
        if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
          throw new Error("Cursor agent did not return a JSON object.");
        }
        throwIfAborted(signal);
        await writeFile(outputPath, `${JSON.stringify(structured, null, 2)}\n`, "utf8");
        throwIfAborted(signal);
        resolveOnce({ usage: emptyUsage() });
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          rejectOnce(createCursorAbortError(signal?.reason || error));
          return;
        }
        const executionError = createCursorExecError(
          error instanceof Error ? error.message : String(error),
        );
        executionError.cause = error;
        rejectOnce(executionError);
      }
    });

    child.stdin.on("error", () => {
      // Process termination is reported through the child close/error handlers.
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child.stdin.end(fullPrompt);
  });
}

function configuredTimeoutMs() {
  const configured = Number(process.env.PRC_CURSOR_AGENT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CURSOR_AGENT_TIMEOUT_MS;
}

function assertTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeoutMs must be a positive number.");
  }
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Cursor agent did not return a JSON object.");
  }
}

function createCursorAbortError(reason) {
  const error = createAbortError(reason);
  error.usage = emptyUsage();
  return error;
}

function createCursorExecError(message) {
  const error = new Error(message);
  error.usage = emptyUsage();
  return error;
}
