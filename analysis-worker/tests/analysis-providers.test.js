import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_MODELS,
  analysisCliModelId,
  createAnalysisCatalog,
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_PROVIDER,
  DEFAULT_ANALYSIS_REASONING_EFFORT,
  inferAnalysisProvider as inferSharedProvider,
  mergeAnalysisModels,
  normalizeSettingsAnalysisChoice,
  parseCursorModelList,
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
  serializeCursorExecutor,
} from "../workflow/07-run-retry-loop/cursor-agent.js";

test("analysis defaults map to expected providers", () => {
  assert.equal(DEFAULT_ANALYSIS_MODEL, "cursor-grok-4.6");
  assert.equal(DEFAULT_ANALYSIS_PROVIDER, "cursor");
  assert.equal(DEFAULT_ANALYSIS_REASONING_EFFORT, "xhigh");
  assert.equal(inferSharedProvider("cursor-grok-4.6"), "cursor");
  assert.equal(inferSharedProvider("grok-4.6"), "cursor");
  assert.equal(inferSharedProvider("gpt-5.6-sol"), "codex");
  assert.equal(inferSharedProvider(""), "cursor");
  assert.equal(inferSharedProvider("unknown-model"), "cursor");
  assert.ok(
    ANALYSIS_MODELS.some((model) => model.id === "gpt-5.6-terra" && model.provider === "codex"),
  );
  assert.ok(ANALYSIS_MODELS.some((model) => model.id === "sonnet" && model.provider === "claude"));
  assert.equal(
    createAnalysisCatalog().providers.find((entry) => entry.id === "cursor")?.label,
    "Cursor Agent",
  );
  assert.equal(
    createAnalysisCatalog().providers.find((entry) => entry.id === "cursor")?.defaultModel,
    "cursor-grok-4.6",
  );
  assert.equal(
    createAnalysisCatalog().providers.find((entry) => entry.id === "cursor")
      ?.defaultReasoningEffort,
    "xhigh",
  );
  assert.deepEqual(
    createAnalysisCatalog()
      .providers.find((entry) => entry.id === "cursor")
      .models.map((model) => model.id)
      .sort(),
    ["auto", "composer-2.5", "cursor-grok-4.5", "cursor-grok-4.6"],
  );
});

test("analysis provider helpers resolve executors", () => {
  assert.equal(normalizeAnalysisProvider("cursor"), "cursor");
  assert.equal(inferAnalysisProvider("cursor-grok-4.5"), "cursor");
  assert.equal(resolveAnalysisExecutor({ model: "gpt-5.6-sol", provider: "codex" }), runCodexExec);
  assert.equal(resolveAnalysisExecutor({ provider: "claude" }), runClaudeExec);
  assert.equal(resolveAnalysisExecutor({ provider: "codex" }), runCodexExec);
  assert.equal(typeof resolveAnalysisExecutor({ model: "cursor-grok-4.5" }), "function");
  assert.notEqual(resolveAnalysisExecutor({ model: "cursor-grok-4.5" }), runCodexExec);
  assert.throws(() => normalizeAnalysisProvider("nope"), /Unsupported analysis provider/);
});

test("settings analysis choice keeps provider, model, and effort coherent", () => {
  assert.deepEqual(normalizeSettingsAnalysisChoice({}), {
    defaultAnalysisProvider: "cursor",
    defaultAnalysisModel: "cursor-grok-4.6",
    defaultAnalysisReasoningEffort: "xhigh",
  });
  assert.equal(
    normalizeSettingsAnalysisChoice({ defaultAnalysisModel: "grok-4.5" }).defaultAnalysisModel,
    "cursor-grok-4.5",
  );
  assert.equal(
    normalizeSettingsAnalysisChoice({ defaultAnalysisModel: "grok-4.6" }).defaultAnalysisModel,
    "cursor-grok-4.6",
  );
  assert.equal(
    normalizeSettingsAnalysisChoice({
      defaultAnalysisProvider: "codex",
      defaultAnalysisModel: "gpt-5.6-sol",
      defaultAnalysisReasoningEffort: "xhigh",
    }).defaultAnalysisReasoningEffort,
    "xhigh",
  );
  assert.equal(
    normalizeSettingsAnalysisChoice({
      defaultAnalysisProvider: "claude",
      defaultAnalysisModel: "not a model",
    }).defaultAnalysisModel,
    "sonnet",
  );
  assert.deepEqual(
    normalizeSettingsAnalysisChoice({
      defaultAnalysisProvider: "cursor",
      defaultAnalysisModel: "gpt-5.6-sol",
    }),
    {
      defaultAnalysisProvider: "cursor",
      defaultAnalysisModel: "cursor-grok-4.6",
      defaultAnalysisReasoningEffort: "xhigh",
    },
  );
  assert.equal(
    normalizeSettingsAnalysisChoice({
      defaultAnalysisProvider: "cursor",
      defaultAnalysisModel: "composer-3",
    }).defaultAnalysisModel,
    "composer-3",
  );
});

test("cursor model lists group families and efforts", () => {
  const parsed = parseCursorModelList(`
Available models
cursor-grok-4.5-high - Cursor Grok 4.5
cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast
cursor-grok-4.5-low - Cursor Grok 4.5 Low
composer-2.5 - Composer 2.5
composer-3 - Composer 3
auto - Auto
gpt-5.6-terra-high - GPT-5.6 Terra 1M High
claude-4.5-sonnet-high - Claude 4.5 Sonnet
gemini-3-pro - Gemini 3 Pro
`);
  const grok = parsed.find((model) => model.id === "cursor-grok-4.5");
  const composer = parsed.find((model) => model.id === "composer-2.5");
  assert.deepEqual(grok.reasoningEfforts, ["low", "high"]);
  assert.equal(grok.encodeEffortInModelId, true);
  assert.equal(composer.encodeEffortInModelId, false);
  assert.ok(parsed.some((model) => model.id === "composer-3"));
  assert.ok(parsed.some((model) => model.id === "auto"));
  assert.equal(
    parsed.find((model) => model.id === "gpt-5.6-terra"),
    undefined,
  );
  assert.equal(
    parsed.find((model) => model.id === "claude-4.5-sonnet"),
    undefined,
  );
  assert.equal(
    parsed.find((model) => model.id === "gemini-3-pro"),
    undefined,
  );
  const merged = mergeAnalysisModels(ANALYSIS_MODELS, parsed);
  const cursorCatalog = createAnalysisCatalog(merged).providers.find(
    (entry) => entry.id === "cursor",
  );
  assert.ok(cursorCatalog.models.some((model) => model.id === "cursor-grok-4.5"));
  assert.ok(cursorCatalog.models.some((model) => model.id === "composer-3"));
  assert.equal(
    cursorCatalog.models.some((model) => model.id.startsWith("gpt-")),
    false,
  );
});

test("cursor agent builds ask-mode args and parses json payloads", () => {
  assert.equal(
    resolveCursorModelId({ model: "grok-4.5", reasoningEffort: "high" }),
    "cursor-grok-4.5-high",
  );
  assert.equal(analysisCliModelId("cursor-grok-4.5", "medium"), "cursor-grok-4.5-medium");
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
    "cursor-grok-4.5-high",
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
