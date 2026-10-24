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
  normalizeSettingsAnalysisChoice,
  parseCodexModelCatalog,
} from "../../shared/analysis-models.js";
import {
  inferAnalysisProvider,
  normalizeAnalysisProvider,
  resolveAnalysisExecutor,
} from "../workflow/07-run-retry-loop/analysis-providers.js";
import { runCodexExec } from "../workflow/07-run-retry-loop/codex-exec.js";

test("analysis defaults are codex-only", () => {
  assert.equal(DEFAULT_ANALYSIS_MODEL, "gpt-5.6-sol");
  assert.equal(DEFAULT_ANALYSIS_PROVIDER, "codex");
  assert.equal(DEFAULT_ANALYSIS_REASONING_EFFORT, "medium");
  assert.equal(inferSharedProvider("gpt-5.6-sol"), "codex");
  assert.equal(inferSharedProvider("cursor-grok-4.6"), "codex");
  assert.equal(inferSharedProvider(""), "codex");
  assert.ok(ANALYSIS_MODELS.every((model) => model.provider === "codex"));
  assert.equal(createAnalysisCatalog().providers.length, 1);
  assert.equal(createAnalysisCatalog().providers[0]?.id, "codex");
  assert.equal(createAnalysisCatalog().providers[0]?.defaultModel, "gpt-5.6-sol");
  assert.deepEqual(
    createAnalysisCatalog()
      .providers[0].models.map((model) => model.id)
      .slice(0, 3),
    ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"],
  );
});

test("analysis provider helpers always resolve codex", () => {
  assert.equal(normalizeAnalysisProvider("codex"), "codex");
  assert.equal(normalizeAnalysisProvider(undefined), "codex");
  assert.equal(inferAnalysisProvider("gpt-5.6-sol"), "codex");
  assert.equal(resolveAnalysisExecutor(), runCodexExec);
  assert.equal(resolveAnalysisExecutor({ model: "gpt-5.6-sol", provider: "codex" }), runCodexExec);
  assert.throws(() => normalizeAnalysisProvider("cursor"), /Unsupported analysis provider/);
});

test("settings analysis choice keeps codex model and effort coherent", () => {
  assert.deepEqual(normalizeSettingsAnalysisChoice({}), {
    defaultAnalysisProvider: "codex",
    defaultAnalysisModel: "gpt-5.6-sol",
    defaultAnalysisReasoningEffort: "medium",
  });
  assert.deepEqual(
    normalizeSettingsAnalysisChoice({
      defaultAnalysisProvider: "cursor",
      defaultAnalysisModel: "cursor-grok-4.6",
    }),
    {
      defaultAnalysisProvider: "codex",
      defaultAnalysisModel: "gpt-5.6-sol",
      defaultAnalysisReasoningEffort: "medium",
    },
  );
  assert.deepEqual(
    normalizeSettingsAnalysisChoice({
      defaultAnalysisProvider: "claude",
      defaultAnalysisModel: "sonnet",
    }),
    {
      defaultAnalysisProvider: "codex",
      defaultAnalysisModel: "gpt-5.6-sol",
      defaultAnalysisReasoningEffort: "medium",
    },
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
      defaultAnalysisProvider: "codex",
      defaultAnalysisModel: "gpt-6-sol",
      defaultAnalysisReasoningEffort: "ultra",
    }).defaultAnalysisReasoningEffort,
    "ultra",
  );
});

test("codex catalogs keep listed models and their efforts", () => {
  const parsed = parseCodexModelCatalog({
    models: [
      {
        slug: "gpt-6-sol",
        display_name: "GPT-6-Sol",
        visibility: "list",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }, { effort: "medium" }],
      },
      {
        slug: "gpt-daybreak-blue-latest",
        display_name: "Daybreak Blue",
        visibility: "hide",
        supported_reasoning_levels: [{ effort: "low" }],
      },
      { slug: "not a model", display_name: "Broken", visibility: "list" },
    ],
  });
  assert.deepEqual(
    parsed.map((model) => model.id),
    ["gpt-6-sol"],
  );
  assert.equal(parsed[0].provider, "codex");
  assert.equal(parsed[0].label, "GPT-6-Sol");
  assert.deepEqual(parsed[0].reasoningEfforts, ["low", "medium", "ultra"]);
  assert.equal(parsed[0].encodeEffortInModelId, false);
  const catalog = createAnalysisCatalog([...ANALYSIS_MODELS, ...parsed]);
  assert.ok(catalog.providers[0].models.some((model) => model.id === "gpt-6-sol"));
});

test("analysisCliModelId passes through canonical model ids", () => {
  assert.equal(analysisCliModelId("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(analysisCliModelId("gpt-6-sol"), "gpt-6-sol");
});
