/** Production analysis-provider registry, model catalog, and settings defaults. */

export const DEFAULT_ANALYSIS_PROVIDER = "codex";
export const DEFAULT_ANALYSIS_MODEL = "gpt-5.6-sol";
export const DEFAULT_ANALYSIS_REASONING_EFFORT = "medium";

export const ANALYSIS_REASONING_EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const reasoningEffortOrder = ANALYSIS_REASONING_EFFORTS;

export const ANALYSIS_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "codex",
    label: "Codex",
    reasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
    defaultModel: DEFAULT_ANALYSIS_MODEL,
    defaultReasoningEffort: DEFAULT_ANALYSIS_REASONING_EFFORT,
  }),
]);

const CODEX_MODELS = [
  model("gpt-5.6-sol", "GPT-5.6 Sol"),
  model("gpt-5.6-terra", "GPT-5.6 Terra"),
  model("gpt-5.5", "GPT-5.5"),
  model("gpt-5.4", "GPT-5.4"),
  model("gpt-5.3-codex", "Codex 5.3"),
  model("gpt-5.2", "GPT-5.2"),
];

export const ANALYSIS_MODELS = Object.freeze(
  CODEX_MODELS.map((entry) => withProvider(entry, "codex")),
);

export function normalizeAnalysisProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  return provider === "codex" ? "codex" : null;
}

export function findAnalysisProvider(provider) {
  const id = normalizeAnalysisProvider(provider);
  return ANALYSIS_PROVIDERS.find((entry) => entry.id === id) ?? null;
}

export function inferAnalysisProvider(_model, provider) {
  return normalizeAnalysisProvider(provider) ?? DEFAULT_ANALYSIS_PROVIDER;
}

export function isAnalysisModelId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$/.test(value.trim());
}

export function canonicalizeAnalysisModelId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return "";
  const aliased = ANALYSIS_MODELS.find((entry) => entry.aliases.includes(id));
  return aliased?.id ?? id;
}

export function findAnalysisModel(model, provider) {
  const id = canonicalizeAnalysisModelId(model);
  if (!id) return null;
  const requestedProvider = normalizeAnalysisProvider(provider);
  return (
    ANALYSIS_MODELS.find(
      (entry) => entry.id === id && (!requestedProvider || entry.provider === requestedProvider),
    ) ?? null
  );
}

export function modelsForProvider(provider, models = ANALYSIS_MODELS) {
  const selected = normalizeAnalysisProvider(provider);
  if (!selected) return [];
  return models.filter((entry) => entry.provider === selected);
}

export function seedModelsForProvider(provider) {
  return modelsForProvider(provider, ANALYSIS_MODELS);
}

export function resolveProviderCatalogModels(provider, discovered = []) {
  const selected = normalizeAnalysisProvider(provider);
  if (!selected) return [];
  return discovered.length > 0 ? discovered : seedModelsForProvider(selected);
}

export function reasoningEffortsFor({ model, provider } = {}, models = ANALYSIS_MODELS) {
  const selectedProvider = inferAnalysisProvider(model, provider);
  const entry = findModelIn(models, model, selectedProvider);
  if (Array.isArray(entry?.reasoningEfforts) && entry.reasoningEfforts.length > 0) {
    return [...entry.reasoningEfforts];
  }
  return [...(findAnalysisProvider(selectedProvider)?.reasoningEfforts ?? [])];
}

export function analysisModelReasoningEffort(model, provider) {
  const entry = findAnalysisModel(model, provider);
  if (!entry) return null;
  return (
    entry.defaultReasoningEffort ??
    findAnalysisProvider(entry.provider)?.defaultReasoningEffort ??
    null
  );
}

export function analysisCliModelId(model) {
  return canonicalizeAnalysisModelId(model);
}

function codexDefaultChoice() {
  return {
    defaultAnalysisProvider: DEFAULT_ANALYSIS_PROVIDER,
    defaultAnalysisModel: DEFAULT_ANALYSIS_MODEL,
    defaultAnalysisReasoningEffort: DEFAULT_ANALYSIS_REASONING_EFFORT,
  };
}

export function normalizeSettingsAnalysisChoice(value = {}) {
  const legacyProvider =
    typeof value.defaultAnalysisProvider === "string"
      ? value.defaultAnalysisProvider.trim().toLowerCase()
      : "";
  if (legacyProvider === "claude" || legacyProvider === "cursor") {
    return codexDefaultChoice();
  }

  const provider = DEFAULT_ANALYSIS_PROVIDER;
  const requestedModel = canonicalizeAnalysisModelId(value.defaultAnalysisModel);
  const modelEntry = findAnalysisModel(requestedModel, provider);
  const known = modelsForProvider(provider);
  const model = known.some((entry) => entry.id === requestedModel)
    ? requestedModel
    : !modelEntry && isAnalysisModelId(requestedModel)
      ? requestedModel
      : DEFAULT_ANALYSIS_MODEL;
  const efforts = reasoningEffortsFor({ model, provider });
  const requestedEffort =
    typeof value.defaultAnalysisReasoningEffort === "string"
      ? value.defaultAnalysisReasoningEffort.trim().toLowerCase()
      : "";
  const reasoningEffort = efforts.includes(requestedEffort)
    ? requestedEffort
    : !modelEntry && isAnalysisModelId(model) && reasoningEffortOrder.includes(requestedEffort)
      ? requestedEffort
      : analysisModelReasoningEffort(model, provider);

  return {
    defaultAnalysisProvider: provider,
    defaultAnalysisModel: model,
    defaultAnalysisReasoningEffort: reasoningEffort || DEFAULT_ANALYSIS_REASONING_EFFORT,
  };
}

export function settingsAnalysisRunOptions(settings) {
  const choice = normalizeSettingsAnalysisChoice(settings);
  return {
    model: choice.defaultAnalysisModel,
    provider: choice.defaultAnalysisProvider,
    reasoningEffort: choice.defaultAnalysisReasoningEffort,
  };
}

export function createAnalysisCatalog(models = ANALYSIS_MODELS) {
  return {
    providers: ANALYSIS_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      defaultModel: provider.defaultModel,
      defaultReasoningEffort: provider.defaultReasoningEffort,
      reasoningEfforts: [...provider.reasoningEfforts],
      models: sortAnalysisModelsLatestFirst(modelsForProvider(provider.id, models)).map(
        (entry) => ({
          id: entry.id,
          label: entry.label,
          reasoningEfforts: reasoningEffortsFor({ model: entry.id, provider: provider.id }, models),
        }),
      ),
    })),
  };
}

export function createAnalysisDashboardConfiguration(models = ANALYSIS_MODELS) {
  const uniqueModels = [];
  const modelProviders = {};
  const modelReasoningEfforts = {};
  for (const entry of models) {
    if (!uniqueModels.includes(entry.id)) uniqueModels.push(entry.id);
    if (!modelProviders[entry.id]) modelProviders[entry.id] = entry.provider;
    const efforts = reasoningEffortsFor(
      { model: entry.id, provider: modelProviders[entry.id] },
      models,
    );
    modelReasoningEfforts[entry.id] =
      efforts.length > 0 ? efforts : [DEFAULT_ANALYSIS_REASONING_EFFORT];
  }
  const reasoningEfforts = orderedEfforts([
    ...new Set(Object.values(modelReasoningEfforts).flat()),
  ]);

  return {
    defaultModel: DEFAULT_ANALYSIS_MODEL,
    models: uniqueModels,
    modelProviders,
    reasoningEfforts,
    modelReasoningEfforts,
  };
}

export function parseCodexModelCatalog(payload) {
  const document = typeof payload === "string" ? parseJsonDocument(payload) : payload;
  const models = Array.isArray(document?.models) ? document.models : [];
  const provider = findAnalysisProvider("codex");
  return models.flatMap((entry) => {
    const id = typeof entry?.slug === "string" ? entry.slug.trim() : "";
    if (entry?.visibility !== "list" || !isAnalysisModelId(id)) return [];
    const efforts = orderedEfforts(
      (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []).map(
        (level) => level?.effort,
      ),
    );
    const defaultEffort = normalizeEffortName(entry.default_reasoning_level);
    const reasoningEfforts = efforts.length > 0 ? efforts : [...(provider?.reasoningEfforts ?? [])];
    return [
      Object.freeze({
        id,
        provider: "codex",
        label:
          typeof entry.display_name === "string" && entry.display_name.trim()
            ? entry.display_name.trim()
            : id,
        aliases: Object.freeze([]),
        encodeEffortInModelId: false,
        cliEffortAliases: Object.freeze({}),
        reasoningEfforts: Object.freeze(reasoningEfforts),
        defaultReasoningEffort:
          defaultEffort && reasoningEfforts.includes(defaultEffort)
            ? defaultEffort
            : provider?.defaultReasoningEffort,
      }),
    ];
  });
}

function model(id, label, extra = {}) {
  return {
    id,
    label,
    aliases: Object.freeze(extra.aliases ?? []),
    encodeEffortInModelId: false,
    cliEffortAliases: Object.freeze(extra.cliEffortAliases ?? {}),
    reasoningEfforts: extra.reasoningEfforts,
    defaultReasoningEffort: extra.defaultReasoningEffort,
  };
}

function withProvider(entry, provider) {
  const providerEntry = findAnalysisProvider(provider);
  return Object.freeze({
    ...entry,
    provider,
    encodeEffortInModelId: false,
    defaultReasoningEffort: entry.defaultReasoningEffort ?? providerEntry?.defaultReasoningEffort,
    reasoningEfforts: Object.freeze(
      entry.reasoningEfforts ?? providerEntry?.reasoningEfforts ?? [],
    ),
  });
}

function findModelIn(models, modelId, provider) {
  const id = canonicalizeAnalysisModelId(modelId);
  const requestedProvider = normalizeAnalysisProvider(provider);
  return (
    models.find(
      (entry) => entry.id === id && (!requestedProvider || entry.provider === requestedProvider),
    ) ?? null
  );
}

function normalizeEffortName(value) {
  const effort = String(value || "")
    .trim()
    .toLowerCase();
  if (effort === "extra-high") return "xhigh";
  if (effort === "minimal") return "low";
  return reasoningEffortOrder.includes(effort) ? effort : null;
}

function parseJsonDocument(text) {
  const source = String(text || "").trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function orderedEfforts(values) {
  const names = new Set(values.map((value) => normalizeEffortName(value)).filter(Boolean));
  return reasoningEffortOrder.filter((effort) => names.delete(effort)).concat([...names]);
}

function sortAnalysisModelsLatestFirst(models) {
  return [...models].sort((left, right) =>
    right.id.localeCompare(left.id, "en", { numeric: true, sensitivity: "base" }),
  );
}
