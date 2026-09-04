/** Production analysis-provider registry, model catalog, and settings defaults. */

export const DEFAULT_ANALYSIS_PROVIDER = "cursor";
export const DEFAULT_ANALYSIS_MODEL = "cursor-grok-4.6";
export const DEFAULT_ANALYSIS_REASONING_EFFORT = "xhigh";

const reasoningEffortOrder = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);
const effortSuffixPattern = /-(none|minimal|low|medium|high|xhigh|extra-high|max)$/i;
const fastSuffixPattern = /-fast$/i;

export const ANALYSIS_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "cursor",
    label: "Cursor Agent",
    reasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    defaultModel: DEFAULT_ANALYSIS_MODEL,
    defaultReasoningEffort: DEFAULT_ANALYSIS_REASONING_EFFORT,
  }),
  Object.freeze({
    id: "claude",
    label: "Claude",
    reasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    defaultModel: "sonnet",
    defaultReasoningEffort: "high",
  }),
  Object.freeze({
    id: "codex",
    label: "Codex",
    reasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh"]),
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "medium",
  }),
]);

const CURSOR_MODELS = [
  model("cursor-grok-4.6", "Grok 4.6", { aliases: ["grok-4.6"] }),
  model("cursor-grok-4.5", "Grok 4.5", { aliases: ["grok-4.5"] }),
  model("composer-2.5", "Composer 2.5", { encodeEffortInModelId: false }),
  model("auto", "Auto", { encodeEffortInModelId: false }),
];

const CLAUDE_MODELS = [
  model("sonnet", "Sonnet (latest)"),
  model("opus", "Opus (latest)"),
  model("haiku", "Haiku (latest)"),
  model("claude-sonnet-4-6", "Claude Sonnet 4.6"),
  model("claude-opus-4-8", "Claude Opus 4.8"),
  model("claude-opus-4-6", "Claude Opus 4.6"),
  model("claude-sonnet-5", "Claude Sonnet 5"),
  model("claude-opus-5", "Claude Opus 5"),
  model("claude-fable-5", "Claude Fable 5"),
];

const CODEX_MODELS = [
  model("gpt-5.6-sol", "GPT-5.6 Sol"),
  model("gpt-5.6-terra", "GPT-5.6 Terra"),
  model("gpt-5.5", "GPT-5.5"),
  model("gpt-5.4", "GPT-5.4"),
  model("gpt-5.3-codex", "Codex 5.3"),
  model("gpt-5.2", "GPT-5.2"),
];

export const ANALYSIS_MODELS = Object.freeze([
  ...CURSOR_MODELS.map((entry) => withProvider(entry, "cursor")),
  ...CLAUDE_MODELS.map((entry) => withProvider(entry, "claude")),
  ...CODEX_MODELS.map((entry) => withProvider(entry, "codex")),
]);

export function normalizeAnalysisProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ANALYSIS_PROVIDERS.some((entry) => entry.id === provider) ? provider : null;
}

export function findAnalysisProvider(provider) {
  const id = normalizeAnalysisProvider(provider);
  return ANALYSIS_PROVIDERS.find((entry) => entry.id === id) ?? null;
}

export function inferAnalysisProvider(model, provider) {
  const requested = normalizeAnalysisProvider(provider);
  if (requested) return requested;
  return findAnalysisModel(model)?.provider ?? DEFAULT_ANALYSIS_PROVIDER;
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

export function reasoningEffortsFor({ model, provider } = {}, models = ANALYSIS_MODELS) {
  const selectedProvider = inferAnalysisProvider(model, provider);
  const entry = findModelIn(models, model, selectedProvider);
  if (entry?.encodeEffortInModelId === false) {
    return Array.isArray(entry.reasoningEfforts) ? [...entry.reasoningEfforts] : [];
  }
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

export function analysisCliModelId(model, reasoningEffort, provider) {
  const selected = canonicalizeAnalysisModelId(model);
  if (!selected) return selected;
  const selectedProvider = inferAnalysisProvider(selected, provider);
  if (selectedProvider !== "cursor") return selected;

  const entry = findAnalysisModel(selected, "cursor");
  const effort = typeof reasoningEffort === "string" ? reasoningEffort.trim().toLowerCase() : "";
  if (!entry || entry.encodeEffortInModelId === false || !effort) {
    return entry?.id ?? selected;
  }
  const suffix = entry.cliEffortAliases?.[effort] ?? effort;
  return `${entry.id}-${suffix}`;
}

export function normalizeSettingsAnalysisChoice(value = {}) {
  const requestedModel = canonicalizeAnalysisModelId(value.defaultAnalysisModel);
  const modelEntry = findAnalysisModel(requestedModel);
  const provider =
    normalizeAnalysisProvider(value.defaultAnalysisProvider) ||
    modelEntry?.provider ||
    DEFAULT_ANALYSIS_PROVIDER;
  const known = modelsForProvider(provider);
  const model = known.some((entry) => entry.id === requestedModel)
    ? requestedModel
    : !modelEntry && isAnalysisModelId(requestedModel)
      ? requestedModel
      : (findAnalysisProvider(provider)?.defaultModel ?? DEFAULT_ANALYSIS_MODEL);
  const efforts = reasoningEffortsFor({ model, provider });
  const requestedEffort =
    typeof value.defaultAnalysisReasoningEffort === "string"
      ? value.defaultAnalysisReasoningEffort.trim().toLowerCase()
      : "";
  const reasoningEffort = efforts.includes(requestedEffort)
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
      models: modelsForProvider(provider.id, models).map((entry) => ({
        id: entry.id,
        label: entry.label,
        reasoningEfforts: reasoningEffortsFor({ model: entry.id, provider: provider.id }, models),
      })),
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

export function parseCursorModelList(text) {
  const grouped = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^(?<id>[A-Za-z0-9._:+-]+)(?:\s+-\s+(?<label>.+))?$/.exec(line.trim());
    if (!match?.groups?.id || match.groups.id === "Available") continue;
    const parsed = parseCursorModelId(match.groups.id, match.groups.label);
    if (!parsed || !isCursorNativeModelId(parsed.id)) continue;
    const current = grouped.get(parsed.id) ?? {
      id: parsed.id,
      provider: "cursor",
      label: parsed.label,
      aliases: Object.freeze([]),
      encodeEffortInModelId: false,
      cliEffortAliases: Object.freeze({}),
      reasoningEfforts: [],
      defaultReasoningEffort: DEFAULT_ANALYSIS_REASONING_EFFORT,
    };
    if (parsed.effort && !current.reasoningEfforts.includes(parsed.effort)) {
      current.reasoningEfforts.push(parsed.effort);
      current.encodeEffortInModelId = true;
    }
    if (parsed.label && (parsed.effort == null || current.label === parsed.id)) {
      current.label = parsed.label;
    }
    grouped.set(parsed.id, current);
  }

  return [...grouped.values()].map((entry) =>
    Object.freeze({
      ...entry,
      reasoningEfforts: Object.freeze(orderedEfforts(entry.reasoningEfforts)),
    }),
  );
}

export function mergeAnalysisModels(seed = ANALYSIS_MODELS, discovered = []) {
  const merged = new Map();
  for (const entry of [...seed, ...discovered]) {
    if (!entry?.id || !entry?.provider) continue;
    const key = `${entry.provider}:${entry.id}`;
    const previous = merged.get(key);
    merged.set(
      key,
      Object.freeze({
        ...(previous ?? emptyModel(entry.id, entry.provider)),
        ...entry,
        aliases: Object.freeze([
          ...new Set([...(previous?.aliases ?? []), ...(entry.aliases ?? [])]),
        ]),
        reasoningEfforts: Object.freeze(
          orderedEfforts([
            ...(previous?.reasoningEfforts ?? []),
            ...(entry.reasoningEfforts ?? []),
          ]),
        ),
        cliEffortAliases: Object.freeze({
          ...(previous?.cliEffortAliases ?? {}),
          ...(entry.cliEffortAliases ?? {}),
        }),
      }),
    );
  }
  return Object.freeze([...merged.values()]);
}

function model(id, label, extra = {}) {
  return {
    id,
    label,
    aliases: Object.freeze(extra.aliases ?? []),
    encodeEffortInModelId: extra.encodeEffortInModelId,
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
    encodeEffortInModelId:
      entry.encodeEffortInModelId ?? (provider === "cursor" && entry.id !== "auto"),
    defaultReasoningEffort: entry.defaultReasoningEffort ?? providerEntry?.defaultReasoningEffort,
    reasoningEfforts: Object.freeze(
      entry.reasoningEfforts ??
        (provider === "cursor" && entry.encodeEffortInModelId === false
          ? []
          : providerEntry.reasoningEfforts),
    ),
  });
}

function emptyModel(id, provider) {
  return {
    id,
    provider,
    label: id,
    aliases: Object.freeze([]),
    encodeEffortInModelId: provider === "cursor",
    cliEffortAliases: Object.freeze({}),
    reasoningEfforts: Object.freeze([]),
    defaultReasoningEffort: findAnalysisProvider(provider)?.defaultReasoningEffort,
  };
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

function isCursorNativeModelId(value) {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  return (
    id === "auto" || id === "composer" || id.startsWith("composer-") || id.startsWith("cursor-")
  );
}

function parseCursorModelId(rawId, rawLabel) {
  if (rawId === "Available" || rawId === "Tip:") return null;
  const fast = fastSuffixPattern.test(rawId);
  if (fast) return null;
  const effortMatch = effortSuffixPattern.exec(rawId);
  const effort = effortMatch ? normalizeEffortName(effortMatch[1]) : null;
  const id = effortMatch ? rawId.slice(0, effortMatch.index) : rawId;
  if (!id) return null;
  const label = cleanCursorLabel(rawLabel, effort) || id;
  return { id, effort, label };
}

function normalizeEffortName(value) {
  const effort = String(value || "")
    .trim()
    .toLowerCase();
  if (effort === "extra-high") return "xhigh";
  if (effort === "minimal") return "low";
  return reasoningEffortOrder.includes(effort) ? effort : null;
}

function cleanCursorLabel(label, effort) {
  if (typeof label !== "string") return "";
  let cleaned = label.replace(/\s*\(NO ZDR\)\s*/gi, "").trim();
  if (effort) {
    cleaned = cleaned
      .replace(/\s+1M(?:\s+|$)/gi, " ")
      .replace(/\s+(None|Low|Medium|High|Extra High|Max|Minimal|Thinking)\s*$/i, "")
      .trim();
  }
  return cleaned;
}

function orderedEfforts(values) {
  const names = new Set(values.map((value) => normalizeEffortName(value)).filter(Boolean));
  return reasoningEffortOrder.filter((effort) => names.delete(effort)).concat([...names]);
}
