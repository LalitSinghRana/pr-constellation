import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCodexExecArgs,
  parseCodexJsonUsage,
  resolveCodexExecutionConfig,
  runCodexExec,
} from "../07-run-retry-loop/codex-exec.js";

assert.deepEqual(
  resolveCodexExecutionConfig({
    env: {
      PRC_CODEX_MODEL: "env-model",
      PRC_CODEX_REASONING_EFFORT: "medium",
    },
  }),
  {
    model: "env-model",
    reasoningEffort: "medium",
  },
);
assert.deepEqual(
  resolveCodexExecutionConfig({
    env: {
      PRC_CODEX_MODEL: "env-model",
      PRC_CODEX_REASONING_EFFORT: "medium",
    },
    model: "selected-model",
    reasoningEffort: "high",
  }),
  {
    model: "selected-model",
    reasoningEffort: "high",
  },
);
assert.throws(() => resolveCodexExecutionConfig({ model: 123 }), /model must be a string/);

const execArgs = buildCodexExecArgs({
  cwd: "/tmp/review",
  model: "selected-model",
  outputPath: "/tmp/output.json",
  reasoningEffort: "high",
  schemaPath: "/tmp/schema.json",
});
assert.ok(execArgs.includes("--json"));
assert.deepEqual(execArgs.slice(execArgs.indexOf("--model"), execArgs.indexOf("--model") + 2), [
  "--model",
  "selected-model",
]);
assert.deepEqual(execArgs.slice(execArgs.indexOf("--config"), execArgs.indexOf("--config") + 2), [
  "--config",
  'model_reasoning_effort="high"',
]);
assert.deepEqual(
  parseCodexJsonUsage(
    [
      '{"type":"thread.started","thread_id":"thread-1"}',
      '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":80,"output_tokens":30,"reasoning_output_tokens":10}}',
      "not-json",
      '{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":5,"output_tokens":4,"reasoning_output_tokens":1}}',
    ].join("\n"),
  ),
  {
    inputTokens: 140,
    cachedInputTokens: 85,
    outputTokens: 34,
    totalTokens: 174,
  },
);

const fakeProcessDir = await mkdtemp(path.join(tmpdir(), "prc-codex-exec-"));
const originalPath = process.env.PATH;
const originalEmitUsage = process.env.PRC_TEST_EMIT_USAGE;
const originalPidPath = process.env.PRC_TEST_PROCESS_PID_PATH;
const originalDescendantPidPath = process.env.PRC_TEST_DESCENDANT_PID_PATH;

try {
  const descendantProcessSource = `
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
writeFileSync(process.env.PRC_TEST_DESCENDANT_PID_PATH, String(process.pid));
setInterval(() => {}, 1000);
`;
  const fakeProcessSource = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
spawn(
  process.execPath,
  ["-e", ${JSON.stringify(descendantProcessSource)}],
  { stdio: "ignore" },
);
writeFileSync(process.env.PRC_TEST_PROCESS_PID_PATH, String(process.pid));
if (process.env.PRC_TEST_EMIT_USAGE === "1") {
  process.stdout.write(
    '{"type":"turn.completed","usage":{"input_tokens":9,"cached_input_tokens":3,"output_tokens":2}}\\n',
  );
}
setInterval(() => {}, 1000);
`;
  const fakeBinaryPath = path.join(fakeProcessDir, "codex");
  await writeFile(fakeBinaryPath, fakeProcessSource, "utf8");
  await chmod(fakeBinaryPath, 0o755);
  process.env.PATH = `${fakeProcessDir}:${originalPath}`;

  const pidPath = path.join(fakeProcessDir, "exec.pid");
  const descendantPidPath = path.join(fakeProcessDir, "exec-descendant.pid");
  process.env.PRC_TEST_PROCESS_PID_PATH = pidPath;
  process.env.PRC_TEST_DESCENDANT_PID_PATH = descendantPidPath;
  process.env.PRC_TEST_EMIT_USAGE = "1";
  const abortController = new AbortController();
  const execPromise = runCodexExec({
    cwd: fakeProcessDir,
    outputPath: path.join(fakeProcessDir, "unused-output.json"),
    prompt: "Analyze this PR.",
    schemaPath: path.join(fakeProcessDir, "unused-schema.json"),
    signal: abortController.signal,
  });
  const pid = Number(await waitForFileText(pidPath));
  const descendantPid = Number(await waitForFileText(descendantPidPath));
  await new Promise((resolve) => setTimeout(resolve, 50));
  abortController.abort(new Error("Stop analysis."));
  let abortError;
  await assert.rejects(execPromise, (error) => {
    abortError = error;
    return error?.name === "AbortError" && error?.code === "ABORT_ERR";
  });
  assert.deepEqual(abortError.usage, {
    inputTokens: 9,
    cachedInputTokens: 3,
    outputTokens: 2,
    totalTokens: 11,
  });
  assert.equal(
    isProcessAlive(pid),
    false,
    "cancellation must not settle before the direct process exits",
  );
  assert.equal(
    isProcessAlive(descendantPid),
    false,
    "cancellation must terminate descendants in its detached process group",
  );
} finally {
  process.env.PATH = originalPath;
  restoreEnvironmentVariable("PRC_TEST_DESCENDANT_PID_PATH", originalDescendantPidPath);
  restoreEnvironmentVariable("PRC_TEST_EMIT_USAGE", originalEmitUsage);
  restoreEnvironmentVariable("PRC_TEST_PROCESS_PID_PATH", originalPidPath);
  await rm(fakeProcessDir, { force: true, recursive: true });
}

async function waitForFileText(filePath, timeoutMs = 3000) {
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
    return;
  }
  process.env[name] = value;
}

console.log("codex executor checks passed");
