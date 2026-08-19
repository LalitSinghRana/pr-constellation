import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAbortError, isAbortError, throwIfAborted } from "../abort.js";
import {
  createChildProcessTerminator,
  USE_DETACHED_PROCESS_GROUP,
} from "../child-process-termination.js";
import { addUsage, emptyUsage } from "./usage.js";

const REVIEW_TREES_SCHEMA_PATH = fileURLToPath(
  new URL("../04-generate-candidate-analysis/03-create-review-trees/schema.json", import.meta.url),
);
const DEFAULT_CLAUDE_EXEC_TIMEOUT_MS = 900_000;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const UNSUPPORTED_CLAUDE_SCHEMA_KEYWORDS = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "uniqueItems",
]);

export function buildClaudeExecArgs({ model, reasoningEffort, schema }) {
  if (schema == null || (typeof schema === "string" && !schema.trim())) {
    throw new TypeError("schema must contain a JSON Schema.");
  }
  let parsedSchema;
  try {
    parsedSchema = typeof schema === "string" ? JSON.parse(schema) : schema;
  } catch (error) {
    throw new TypeError("schema must contain valid JSON.", { cause: error });
  }
  if (!parsedSchema || typeof parsedSchema !== "object") {
    throw new TypeError("schema must contain a JSON Schema object.");
  }
  const schemaText = JSON.stringify(sanitizeClaudeSchema(parsedSchema));

  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    "",
    ...(model ? ["--model", model] : []),
    ...(reasoningEffort ? ["--effort", reasoningEffort] : []),
    "--json-schema",
    schemaText,
  ];
}

export function sanitizeClaudeSchema(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeClaudeSchema);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !UNSUPPORTED_CLAUDE_SCHEMA_KEYWORDS.has(key))
      .map(([key, child]) => [key, sanitizeClaudeSchema(child)]),
  );
}

export function parseClaudeStreamJson(stdout) {
  const events = parseStreamEvents(stdout);
  const resultEvent = events.filter((event) => event?.type === "result").at(-1) || null;

  return {
    events,
    resultEvent,
    structuredOutput: parseStructuredOutput(resultEvent),
    usage: usageFromEvents(events, resultEvent),
  };
}

export function parseClaudeJsonUsage(stdout) {
  const events = parseStreamEvents(stdout);
  const resultEvent = events.filter((event) => event?.type === "result").at(-1) || null;
  return usageFromEvents(events, resultEvent);
}

export async function runClaudeExec({
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

  const schema = JSON.stringify(
    sanitizeClaudeSchema(JSON.parse(await readFile(schemaPath, "utf8"))),
  );
  throwIfAborted(signal);

  const args = buildClaudeExecArgs({
    model,
    reasoningEffort,
    schema,
  });

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      detached: USE_DETACHED_PROCESS_GROUP,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminator = createChildProcessTerminator(child);

    let aborted = false;
    let settled = false;
    let stderr = "";
    let stdout = "";
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
    }, timeoutMs);

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
        rejectOnce(createClaudeAbortError(signal?.reason, stdout));
        return;
      }
      rejectOnce(createClaudeExecError(`Failed to start claude: ${error.message}`, stdout));
    });

    child.on("close", async (code) => {
      clearTimeout(timeoutTimer);
      terminator.childClosed();
      await terminator.waitForTreeExit();

      if (settled) {
        return;
      }
      if (aborted || signal?.aborted) {
        rejectOnce(createClaudeAbortError(signal?.reason, stdout));
        return;
      }
      if (timedOut) {
        rejectOnce(createClaudeExecError(`claude --print timed out after ${timeoutMs}ms.`, stdout));
        return;
      }
      if (outputExceeded) {
        rejectOnce(
          createClaudeExecError(
            `claude --print exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes of process output.`,
            stdout,
          ),
        );
        return;
      }
      if (code !== 0) {
        const details = summarizeClaudeFailure({ stderr, stdout });
        rejectOnce(
          createClaudeExecError(
            `claude --print failed with exit code ${code}${details ? `:\n${details}` : ""}`,
            stdout,
          ),
        );
        return;
      }

      let parsed;
      try {
        parsed = parseClaudeStreamJson(stdout);
        assertSuccessfulResult(parsed.resultEvent);
        if (!isJsonObject(parsed.structuredOutput)) {
          throw new Error("Analysis executor did not return a structured JSON object.");
        }
        throwIfAborted(signal);
        await writeFile(
          outputPath,
          `${JSON.stringify(parsed.structuredOutput, null, 2)}\n`,
          "utf8",
        );
        throwIfAborted(signal);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          rejectOnce(createClaudeAbortError(signal?.reason || error, stdout));
          return;
        }
        const executionError = createClaudeExecError(
          error instanceof Error ? error.message : String(error),
          stdout,
        );
        executionError.cause = error;
        rejectOnce(executionError);
        return;
      }

      resolveOnce({ usage: parsed.usage });
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

function configuredTimeoutMs() {
  const configured = Number(process.env.PRC_CLAUDE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CLAUDE_EXEC_TIMEOUT_MS;
}

function assertTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeoutMs must be a positive number.");
  }
}

function parseStreamEvents(stdout) {
  const events = [];

  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (event && typeof event === "object") {
        events.push(event);
      }
    } catch {
      // The CLI writes one JSON event per line. Ignore unrelated diagnostics so
      // a valid terminal result remains usable.
    }
  }

  return events;
}

function parseStructuredOutput(resultEvent) {
  if (!resultEvent) {
    return null;
  }

  const value = resultEvent.structured_output ?? resultEvent.structuredOutput;
  if (value !== undefined) {
    return parsePossibleJson(value);
  }
  return parsePossibleJson(resultEvent.result);
}

function parsePossibleJson(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function assertSuccessfulResult(resultEvent) {
  if (!resultEvent) {
    throw new Error("Analysis executor stream ended without a result event.");
  }
  if (
    resultEvent.is_error === true ||
    resultEvent.subtype === "error" ||
    resultEvent.subtype === "error_during_execution"
  ) {
    const detail = readClaudeErrorMessage(resultEvent);
    throw new Error(
      `Analysis executor returned an unsuccessful result${detail ? `: ${detail}` : "."}`,
    );
  }
}

function usageFromEvents(events, resultEvent) {
  if (resultEvent?.usage && typeof resultEvent.usage === "object") {
    return normalizeClaudeUsage(resultEvent.usage);
  }

  const assistantUsage = new Map();
  let anonymousIndex = 0;
  for (const event of events) {
    if (
      event?.type !== "assistant" ||
      !event.message?.usage ||
      typeof event.message.usage !== "object"
    ) {
      continue;
    }
    const key =
      typeof event.message.id === "string" && event.message.id
        ? event.message.id
        : `anonymous-${anonymousIndex++}`;
    assistantUsage.set(key, normalizeClaudeUsage(event.message.usage));
  }

  const total = emptyUsage();
  for (const usage of assistantUsage.values()) {
    addUsage(total, usage);
  }
  return total;
}

function normalizeClaudeUsage(value) {
  const uncachedInputTokens = nonNegativeNumber(value?.input_tokens ?? value?.inputTokens);
  const cacheCreationInputTokens = nonNegativeNumber(
    value?.cache_creation_input_tokens ?? value?.cacheCreationInputTokens,
  );
  const cachedInputTokens = nonNegativeNumber(
    value?.cache_read_input_tokens ?? value?.cached_input_tokens ?? value?.cachedInputTokens,
  );
  const outputTokens = nonNegativeNumber(value?.output_tokens ?? value?.outputTokens);
  const inputTokens = uncachedInputTokens + cacheCreationInputTokens + cachedInputTokens;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function summarizeClaudeFailure({ stderr, stdout }) {
  const events = parseStreamEvents(stdout);
  const resultEvent = events.filter((event) => event?.type === "result").at(-1);
  const resultMessage = readClaudeErrorMessage(resultEvent);
  return [resultMessage, String(stderr || "").trim()].filter(Boolean).join("\n").slice(-4000);
}

function readClaudeErrorMessage(event) {
  for (const value of [event?.error?.message, event?.message, event?.result]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function createClaudeAbortError(reason, stdout) {
  const error = createAbortError(reason);
  error.usage = parseClaudeJsonUsage(stdout);
  return error;
}

function createClaudeExecError(message, stdout) {
  const error = new Error(message);
  error.usage = parseClaudeJsonUsage(stdout);
  return error;
}

function isJsonObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
