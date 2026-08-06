import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildClaudeExecArgs,
  parseClaudeJsonUsage,
  parseClaudeStreamJson,
  runClaudeExec,
  sanitizeClaudeSchema,
} from "../07-run-retry-loop/claude-agent.js";

const schema = {
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "fixture/v1" },
    sections: {
      items: { minLength: 1, type: "string" },
      minItems: 1,
      type: "array",
    },
  },
  required: ["schemaVersion", "sections"],
  type: "object",
};
const compactSchema = JSON.stringify(schema);
const compactClaudeSchema = JSON.stringify(sanitizeClaudeSchema(schema));
const args = buildClaudeExecArgs({
  model: "claude-sonnet-4-6",
  reasoningEffort: "high",
  schema: compactSchema,
});

for (const flag of [
  "--print",
  "--verbose",
  "--no-session-persistence",
  "--disable-slash-commands",
  "--no-chrome",
  "--strict-mcp-config",
]) {
  assert.ok(args.includes(flag), `Missing Claude CLI flag ${flag}`);
}
assert.equal(args.at(args.indexOf("--output-format") + 1), "stream-json");
assert.equal(args.at(args.indexOf("--permission-mode") + 1), "dontAsk");
assert.equal(args.at(args.indexOf("--setting-sources") + 1), "");
assert.equal(args.at(args.indexOf("--mcp-config") + 1), '{"mcpServers":{}}');
assert.equal(args.at(args.indexOf("--tools") + 1), "");
assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
  "--model",
  "claude-sonnet-4-6",
]);
assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), [
  "--effort",
  "high",
]);
assert.equal(args.at(args.indexOf("--json-schema") + 1), compactClaudeSchema);
assert.equal(schema.properties.sections.minItems, 1);
assert.equal("minItems" in JSON.parse(compactClaudeSchema).properties.sections, false);

const parsed = parseClaudeStreamJson(
  [
    "non-json diagnostic",
    JSON.stringify({
      message: {
        id: "message-1",
        usage: {
          cache_read_input_tokens: 2,
          input_tokens: 3,
          output_tokens: 4,
        },
      },
      type: "assistant",
    }),
    JSON.stringify({
      is_error: false,
      structured_output: {
        schemaVersion: "fixture/v1",
        sections: ["one"],
      },
      subtype: "success",
      type: "result",
      usage: {
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
        input_tokens: 11,
        output_tokens: 3,
      },
    }),
  ].join("\n"),
);
assert.deepEqual(parsed.structuredOutput, {
  schemaVersion: "fixture/v1",
  sections: ["one"],
});
assert.deepEqual(parsed.usage, {
  cachedInputTokens: 7,
  inputTokens: 23,
  outputTokens: 3,
  totalTokens: 26,
});

assert.deepEqual(
  parseClaudeJsonUsage(
    [
      JSON.stringify({
        message: {
          id: "same-message",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        type: "assistant",
      }),
      JSON.stringify({
        message: {
          id: "same-message",
          usage: {
            cache_read_input_tokens: 3,
            input_tokens: 2,
            output_tokens: 4,
          },
        },
        type: "assistant",
      }),
      JSON.stringify({
        message: {
          id: "second-message",
          usage: { input_tokens: 5, output_tokens: 6 },
        },
        type: "assistant",
      }),
    ].join("\n"),
  ),
  {
    cachedInputTokens: 3,
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
  },
);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "prc-claude-exec-"));
const fakeClaudePath = path.join(temporaryRoot, "claude");
const argsPath = path.join(temporaryRoot, "args.json");
const promptPath = path.join(temporaryRoot, "prompt.txt");
const schemaPath = path.join(temporaryRoot, "schema.json");
const outputPath = path.join(temporaryRoot, "output.json");
const originalPath = process.env.PATH || "";
const originalMode = process.env.PRC_TEST_CLAUDE_MODE;
const originalArgsPath = process.env.PRC_TEST_CLAUDE_ARGS_PATH;
const originalPromptPath = process.env.PRC_TEST_CLAUDE_PROMPT_PATH;
const originalPidPath = process.env.PRC_TEST_CLAUDE_PID_PATH;
const originalDescendantPidPath = process.env.PRC_TEST_CLAUDE_DESCENDANT_PID_PATH;

const descendantSource = `
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
writeFileSync(
  process.env.PRC_TEST_CLAUDE_DESCENDANT_PID_PATH,
  String(process.pid),
);
setInterval(() => {}, 1000);
`;
const fakeClaudeSource = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  writeFileSync(process.env.PRC_TEST_CLAUDE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
  writeFileSync(process.env.PRC_TEST_CLAUDE_PROMPT_PATH, prompt);
  const mode = process.env.PRC_TEST_CLAUDE_MODE;

  if (mode === "success") {
    process.stdout.write(${JSON.stringify(
      `${JSON.stringify({
        message: {
          id: "assistant-success",
          usage: { input_tokens: 2, output_tokens: 1 },
        },
        type: "assistant",
      })}\n`,
    )});
    process.stdout.write(${JSON.stringify(
      `${JSON.stringify({
        is_error: false,
        structured_output: {
          schemaVersion: "fixture/v1",
          sections: ["generated"],
        },
        subtype: "success",
        type: "result",
        usage: {
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
          input_tokens: 11,
          output_tokens: 3,
        },
      })}\n`,
    )});
    return;
  }

  if (mode === "malformed") {
    process.stdout.write('{"type":"system","subtype":"init"}\\n');
    return;
  }

  if (mode === "timeout") {
    writeFileSync(process.env.PRC_TEST_CLAUDE_PID_PATH, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }

  if (mode === "abort") {
    process.on("SIGTERM", () => {});
    process.stdout.write(
      '{"type":"assistant","message":{"id":"partial","usage":{"input_tokens":9,"cache_read_input_tokens":3,"output_tokens":2}}}\\n',
    );
    spawn(
      process.execPath,
      ["-e", ${JSON.stringify(descendantSource)}],
      { stdio: "ignore" },
    );
    writeFileSync(process.env.PRC_TEST_CLAUDE_PID_PATH, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }

  process.stderr.write("fixture failure\\n");
  process.exitCode = 2;
});
`;

try {
  await Promise.all([
    writeFile(fakeClaudePath, fakeClaudeSource, "utf8"),
    writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8"),
  ]);
  await chmod(fakeClaudePath, 0o755);
  process.env.PATH = `${temporaryRoot}:${originalPath}`;
  process.env.PRC_TEST_CLAUDE_ARGS_PATH = argsPath;
  process.env.PRC_TEST_CLAUDE_PROMPT_PATH = promptPath;

  process.env.PRC_TEST_CLAUDE_MODE = "success";
  const success = await runClaudeExec({
    cwd: temporaryRoot,
    model: "claude-sonnet-4-6",
    outputPath,
    prompt: "Analyze this frozen pull request.",
    reasoningEffort: "low",
    schemaPath,
  });
  assert.deepEqual(success.usage, {
    cachedInputTokens: 7,
    inputTokens: 23,
    outputTokens: 3,
    totalTokens: 26,
  });
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
    schemaVersion: "fixture/v1",
    sections: ["generated"],
  });
  assert.equal(await readFile(promptPath, "utf8"), "Analyze this frozen pull request.");
  const invokedArgs = JSON.parse(await readFile(argsPath, "utf8"));
  assert.equal(invokedArgs.at(invokedArgs.indexOf("--model") + 1), "claude-sonnet-4-6");
  assert.equal(invokedArgs.at(invokedArgs.indexOf("--effort") + 1), "low");
  assert.equal(invokedArgs.at(invokedArgs.indexOf("--json-schema") + 1), compactClaudeSchema);
  assert.ok(invokedArgs.includes("--no-session-persistence"));
  assert.equal(invokedArgs.at(invokedArgs.indexOf("--tools") + 1), "");

  process.env.PRC_TEST_CLAUDE_MODE = "malformed";
  await assert.rejects(
    () =>
      runClaudeExec({
        cwd: temporaryRoot,
        outputPath,
        prompt: "Malformed fixture.",
        schemaPath,
      }),
    (error) => /without a result event/.test(error?.message) && error?.usage?.totalTokens === 0,
  );

  const timeoutPidPath = path.join(temporaryRoot, "timeout.pid");
  process.env.PRC_TEST_CLAUDE_MODE = "timeout";
  process.env.PRC_TEST_CLAUDE_PID_PATH = timeoutPidPath;
  await assert.rejects(
    () =>
      runClaudeExec({
        cwd: temporaryRoot,
        outputPath,
        prompt: "Timeout fixture.",
        schemaPath,
        timeoutMs: 50,
      }),
    /timed out after 50ms/,
  );
  assert.equal(
    isProcessAlive(Number(await readFile(timeoutPidPath, "utf8"))),
    false,
    "Claude timeout must not settle before the process exits",
  );

  const abortPidPath = path.join(temporaryRoot, "abort.pid");
  const descendantPidPath = path.join(temporaryRoot, "abort-descendant.pid");
  process.env.PRC_TEST_CLAUDE_MODE = "abort";
  process.env.PRC_TEST_CLAUDE_PID_PATH = abortPidPath;
  process.env.PRC_TEST_CLAUDE_DESCENDANT_PID_PATH = descendantPidPath;
  const abortController = new AbortController();
  const abortPromise = runClaudeExec({
    cwd: temporaryRoot,
    outputPath,
    prompt: "Abort fixture.",
    schemaPath,
    signal: abortController.signal,
  });
  const abortPid = Number(await waitForFileText(abortPidPath));
  const descendantPid = Number(await waitForFileText(descendantPidPath));
  abortController.abort(new Error("Stop Claude analysis."));
  let abortError;
  await assert.rejects(abortPromise, (error) => {
    abortError = error;
    return error?.name === "AbortError" && error?.code === "ABORT_ERR";
  });
  assert.deepEqual(abortError.usage, {
    cachedInputTokens: 3,
    inputTokens: 12,
    outputTokens: 2,
    totalTokens: 14,
  });
  assert.equal(
    isProcessAlive(abortPid),
    false,
    "Claude cancellation must terminate the direct process",
  );
  assert.equal(
    isProcessAlive(descendantPid),
    false,
    "Claude cancellation must terminate descendants",
  );
} finally {
  process.env.PATH = originalPath;
  restoreEnvironmentVariable("PRC_TEST_CLAUDE_MODE", originalMode);
  restoreEnvironmentVariable("PRC_TEST_CLAUDE_ARGS_PATH", originalArgsPath);
  restoreEnvironmentVariable("PRC_TEST_CLAUDE_PROMPT_PATH", originalPromptPath);
  restoreEnvironmentVariable("PRC_TEST_CLAUDE_PID_PATH", originalPidPath);
  restoreEnvironmentVariable("PRC_TEST_CLAUDE_DESCENDANT_PID_PATH", originalDescendantPidPath);
  await rm(temporaryRoot, { force: true, recursive: true });
}

console.log("claude executor checks passed");

async function waitForFileText(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function restoreEnvironmentVariable(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
