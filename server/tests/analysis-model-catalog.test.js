import assert from "node:assert/strict";
import test from "node:test";
import { loadAnalysisCatalog } from "../analysis/analysis-model-catalog.js";

test("analysis catalog uses codex CLI discovery without seed union", async () => {
  const catalog = await loadAnalysisCatalog({
    listCodexModels: async () => [
      {
        id: "gpt-6-sol",
        provider: "codex",
        label: "GPT-6-Sol",
        aliases: [],
        encodeEffortInModelId: false,
        cliEffortAliases: {},
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "medium",
      },
    ],
  });

  assert.equal(catalog.providers.length, 1);
  const codex = catalog.providers.find((provider) => provider.id === "codex");
  assert.ok(codex.models.some((model) => model.id === "gpt-6-sol"));
  assert.equal(
    codex.models.some((model) => model.id === "gpt-5.6-sol"),
    false,
  );
});

test("analysis catalog keeps the seed when model listing fails", async () => {
  const catalog = await loadAnalysisCatalog({
    listCodexModels: async () => {
      throw new Error("codex missing");
    },
  });

  const codex = catalog.providers.find((provider) => provider.id === "codex");
  assert.ok(codex.models.some((model) => model.id === "gpt-5.6-sol"));
  assert.equal(
    codex.models.some((model) => model.id === "gpt-6-sol"),
    false,
  );
});
