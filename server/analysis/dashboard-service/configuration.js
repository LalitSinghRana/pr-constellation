import {
  analysisModelReasoningEffort,
  createAnalysisDashboardConfiguration,
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_REASONING_EFFORT,
  inferAnalysisProvider,
  isAnalysisModelId,
  normalizeAnalysisProvider,
} from "../../../shared/analysis-models.js";

export {
  analysisModelReasoningEffort,
  DEFAULT_ANALYSIS_REASONING_EFFORT,
  isAnalysisModelId,
  normalizeAnalysisProvider,
};

export const DEFAULT_REASONING_EFFORTS = Object.freeze(["low", "medium", "high"]);
const reasoningEffortOrder = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

export async function loadDashboardConfiguration() {
  return normalizeDashboardConfiguration(createAnalysisDashboardConfiguration());
}

export function normalizeDashboardConfiguration(configuration) {
  if (!configuration || typeof configuration !== "object") {
    throw new TypeError("Dashboard configuration must be an object.");
  }

  const defaultModel = normalizeOptionalName(configuration.defaultModel) || DEFAULT_ANALYSIS_MODEL;
  const models = uniqueNames([
    defaultModel,
    ...(Array.isArray(configuration.models) ? configuration.models : []),
  ]);
  const reasoningEfforts = orderedReasoningEfforts(
    Array.isArray(configuration.reasoningEfforts)
      ? configuration.reasoningEfforts
      : DEFAULT_REASONING_EFFORTS,
  );
  if (reasoningEfforts.length === 0) {
    throw new TypeError("Dashboard configuration must include at least one reasoning effort.");
  }

  const configuredByModel =
    configuration.modelReasoningEfforts && typeof configuration.modelReasoningEfforts === "object"
      ? configuration.modelReasoningEfforts
      : {};
  const configuredProviders =
    configuration.modelProviders && typeof configuration.modelProviders === "object"
      ? configuration.modelProviders
      : {};
  const modelProviders = Object.fromEntries(
    models.map((model) => [
      model,
      normalizeModelProvider(configuredProviders[model]) || inferModelProvider(model),
    ]),
  );
  const modelReasoningEfforts = Object.fromEntries(
    models.map((model) => {
      const registryEffort = analysisModelReasoningEffort(model);
      const configured = Array.isArray(configuredByModel[model])
        ? configuredByModel[model]
        : registryEffort
          ? [registryEffort]
          : reasoningEfforts;
      const supported = orderedReasoningEfforts(configured);
      const fallback = registryEffort ? [registryEffort] : reasoningEfforts;
      return [model, supported.length > 0 ? supported : [...fallback]];
    }),
  );

  return { defaultModel, models, modelProviders, reasoningEfforts, modelReasoningEfforts };
}

export function normalizeOptionalName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeModelProvider(value) {
  return normalizeAnalysisProvider(value);
}

export function inferModelProvider(model) {
  return inferAnalysisProvider(model);
}

export function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const aliases = {
    inputTokens: ["inputTokens", "input_tokens"],
    cachedInputTokens: ["cachedInputTokens", "cached_input_tokens", "cachedTokens"],
    outputTokens: ["outputTokens", "output_tokens"],
    totalTokens: ["totalTokens", "total_tokens"],
  };
  const usage = {};
  for (const [target, candidates] of Object.entries(aliases)) {
    const metric = candidates
      .map((candidate) => value[candidate])
      .find(
        (candidate) =>
          typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0,
      );
    if (metric !== undefined) usage[target] = metric;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function orderedReasoningEfforts(values) {
  const names = new Set(uniqueNames(values));
  return [...reasoningEffortOrder.filter((effort) => names.delete(effort)), ...names];
}

function uniqueNames(values) {
  return [...new Set(values.map(normalizeOptionalName).filter(Boolean))];
}
