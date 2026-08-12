/** Production analysis model registry and provider inference. */

export const DEFAULT_ANALYSIS_MODEL = "grok-4.5";
export const FALLBACK_ANALYSIS_MODEL = "gpt-5.6-sol";
export const DEFAULT_ANALYSIS_REASONING_EFFORT = "high";
export const FALLBACK_ANALYSIS_REASONING_EFFORT = "medium";

export const ANALYSIS_MODELS = Object.freeze([
  Object.freeze({
    id: DEFAULT_ANALYSIS_MODEL,
    provider: "cursor",
    label: "Grok 4.5",
    reasoningEffort: DEFAULT_ANALYSIS_REASONING_EFFORT,
  }),
  Object.freeze({
    id: FALLBACK_ANALYSIS_MODEL,
    provider: "codex",
    label: "GPT-5.6 Sol",
    reasoningEffort: FALLBACK_ANALYSIS_REASONING_EFFORT,
  }),
]);

/** Agents offered as the settings "default agent" choice. Expand as more are supported. */
export const SETTINGS_ANALYSIS_AGENTS = Object.freeze([
  Object.freeze({
    id: DEFAULT_ANALYSIS_MODEL,
    label: "Grok 4.5",
    providerLabel: "via Cursor",
  }),
]);

export function normalizeSettingsAnalysisModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return SETTINGS_ANALYSIS_AGENTS.some((agent) => agent.id === id) ? id : DEFAULT_ANALYSIS_MODEL;
}

export function analysisModelReasoningEffort(model) {
  const entry = ANALYSIS_MODELS.find((candidate) => candidate.id === model);
  return entry?.reasoningEffort ?? null;
}

export function createAnalysisDashboardConfiguration() {
  const models = ANALYSIS_MODELS.map((model) => model.id);
  const modelProviders = Object.fromEntries(
    ANALYSIS_MODELS.map((model) => [model.id, model.provider]),
  );
  const modelReasoningEfforts = Object.fromEntries(
    ANALYSIS_MODELS.map((model) => [model.id, [model.reasoningEffort]]),
  );
  const reasoningEfforts = [...new Set(ANALYSIS_MODELS.map((model) => model.reasoningEffort))];

  return {
    defaultModel: DEFAULT_ANALYSIS_MODEL,
    models,
    modelProviders,
    reasoningEfforts,
    modelReasoningEfforts,
  };
}

export function inferAnalysisProvider(model) {
  const value = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (!value) return "codex";
  if (value.startsWith("claude") || value.startsWith("sonnet") || value.startsWith("opus")) {
    return "claude";
  }
  if (value.startsWith("composer") || value.startsWith("grok")) {
    return "cursor";
  }
  return "codex";
}

export function normalizeAnalysisProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (provider === "codex" || provider === "claude" || provider === "cursor") {
    return provider;
  }
  return null;
}
