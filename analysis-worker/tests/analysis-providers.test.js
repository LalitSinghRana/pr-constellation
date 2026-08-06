import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_MODELS,
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_REASONING_EFFORT,
  FALLBACK_ANALYSIS_MODEL,
  FALLBACK_ANALYSIS_REASONING_EFFORT,
  inferAnalysisProvider as inferSharedProvider,
} from "../../shared/analysis-models.js";
import {
  inferAnalysisProvider,
  normalizeAnalysisProvider,
  resolveAnalysisExecutor,
} from "../workflow/07-run-retry-loop/analysis-providers.js";
import { runClaudeExec } from "../workflow/07-run-retry-loop/claude-agent.js";
import { runCodexExec } from "../workflow/07-run-retry-loop/codex-exec.js";
import {
  buildCursorAgentArgs,
  buildCursorAgentPrompt,
  parseCursorAgentJson,
  resolveCursorModelId,
  runCursorAgentExec,
  serializeCursorExecutor,
} from "../workflow/07-run-retry-loop/cursor-agent.js";

test("analysis defaults map to expected providers", () => {
  assert.equal(DEFAULT_ANALYSIS_MODEL, "grok-4.5");
  assert.equal(DEFAULT_ANALYSIS_REASONING_EFFORT, "high");
  assert.equal(FALLBACK_ANALYSIS_MODEL, "gpt-5.6-sol");
  assert.equal(FALLBACK_ANALYSIS_REASONING_EFFORT, "medium");
  assert.deepEqual(
    Object.fromEntries(ANALYSIS_MODELS.map((model) => [model.id, model.reasoningEffort])),
    {
      "grok-4.5": "high",
      "gpt-5.6-sol": "medium",
    },
  );
  assert.equal(inferSharedProvider("grok-4.5"), "cursor");
  assert.equal(inferSharedProvider("composer-2.5"), "cursor");
  assert.equal(inferSharedProvider("sonnet"), "claude");
  assert.equal(inferSharedProvider("claude-opus-4-6[1m]"), "claude");
  assert.equal(inferSharedProvider("gpt-5.6-sol"), "codex");
});

test("analysis provider helpers resolve executors", () => {
  assert.equal(normalizeAnalysisProvider("cursor"), "cursor");
  assert.equal(inferAnalysisProvider("grok-4.5"), "cursor");
  assert.equal(resolveAnalysisExecutor("codex"), runCodexExec);
  assert.equal(resolveAnalysisExecutor("claude"), runClaudeExec);
  assert.equal(resolveAnalysisExecutor("cursor"), runCursorAgentExec);
  assert.throws(() => normalizeAnalysisProvider("nope"), /Unsupported analysis provider/);
});

test("cursor agent builds ask-mode args and parses json payloads", () => {
  assert.equal(
    resolveCursorModelId({ model: "grok-4.5", reasoningEffort: "high" }),
    "grok-4.5-high",
  );
  assert.equal(
    resolveCursorModelId({ model: "grok-4.5", reasoningEffort: "medium" }),
    "grok-4.5-medium",
  );
  assert.equal(
    resolveCursorModelId({ model: "composer-2.5", reasoningEffort: "high" }),
    "composer-2.5",
  );
  assert.deepEqual(buildCursorAgentArgs({ model: "grok-4.5", reasoningEffort: "high" }), [
    "--print",
    "--trust",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--sandbox",
    "enabled",
    "--model",
    "grok-4.5-high",
  ]);
  assert.match(
    buildCursorAgentPrompt({ prompt: "hello", schema: { type: "object" } }),
    /json_schema/,
  );
  assert.deepEqual(parseCursorAgentJson('{"result":"{\\"ok\\":true}"}'), { ok: true });
  assert.deepEqual(parseCursorAgentJson('{"intent":"x"}'), { intent: "x" });
});

test("cursor executor serializes concurrent calls", async () => {
  let active = 0;
  let maximumActive = 0;
  const executeCursor = serializeCursorExecutor(async ({ value }) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return value;
  });

  assert.deepEqual(
    await Promise.all([executeCursor({ value: 1 }), executeCursor({ value: 2 })]),
    [1, 2],
  );
  assert.equal(maximumActive, 1);
});
