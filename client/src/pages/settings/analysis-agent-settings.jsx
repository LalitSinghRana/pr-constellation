import { Label } from "@/components/ui/label.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.jsx";
import { useQuery } from "@/hooks/use-query.js";
import { fetchAnalysisModels } from "@/lib/cockpit-api.js";
import {
  createAnalysisCatalog,
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_PROVIDER,
  DEFAULT_ANALYSIS_REASONING_EFFORT,
  normalizeSettingsAnalysisChoice,
} from "../../../../shared/analysis-models.js";

const effortLabels = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function preferredEffort(efforts, ...candidates) {
  return candidates.find((effort) => effort && efforts.includes(effort)) || efforts[0];
}

export function AnalysisAgentSettings({ busy, catalog, onSave, settings }) {
  const providers = catalog?.providers?.length
    ? catalog.providers
    : createAnalysisCatalog().providers;
  const choice = normalizeSettingsAnalysisChoice(settings);
  const provider =
    providers.find((entry) => entry.id === choice.defaultAnalysisProvider) || providers[0];
  const models = provider?.models ?? [];
  const selectedModel =
    models.find((entry) => entry.id === choice.defaultAnalysisModel) ||
    models.find((entry) => entry.id === provider?.defaultModel) ||
    models[0];
  const efforts = selectedModel?.reasoningEfforts?.length
    ? selectedModel.reasoningEfforts
    : (provider?.reasoningEfforts ?? []);
  const selectedEffort =
    preferredEffort(
      efforts,
      choice.defaultAnalysisReasoningEffort,
      provider?.defaultReasoningEffort,
      DEFAULT_ANALYSIS_REASONING_EFFORT,
    ) ?? DEFAULT_ANALYSIS_REASONING_EFFORT;

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 sm:w-auto sm:flex-row sm:items-end">
      <CatalogSelect
        disabled={busy}
        id="default-analysis-provider"
        label="Provider"
        onValueChange={(value) => {
          const nextProvider = providers.find((entry) => entry.id === value);
          const nextModel =
            nextProvider?.models.find((entry) => entry.id === nextProvider.defaultModel) ||
            nextProvider?.models[0];
          const nextEfforts = nextModel?.reasoningEfforts?.length
            ? nextModel.reasoningEfforts
            : (nextProvider?.reasoningEfforts ?? []);
          onSave(
            normalizeSettingsAnalysisChoice({
              defaultAnalysisProvider: value,
              defaultAnalysisModel: nextModel?.id,
              defaultAnalysisReasoningEffort: preferredEffort(
                nextEfforts,
                nextProvider?.defaultReasoningEffort,
              ),
            }),
          );
        }}
        options={providers.map((entry) => ({ id: entry.id, label: entry.label }))}
        value={provider?.id || DEFAULT_ANALYSIS_PROVIDER}
      />
      <CatalogSelect
        disabled={busy || models.length === 0}
        id="default-analysis-model"
        label="Model"
        onValueChange={(value) => {
          const nextModel = models.find((entry) => entry.id === value);
          const nextEfforts = nextModel?.reasoningEfforts?.length
            ? nextModel.reasoningEfforts
            : efforts;
          onSave(
            normalizeSettingsAnalysisChoice({
              defaultAnalysisProvider: provider?.id,
              defaultAnalysisModel: value,
              defaultAnalysisReasoningEffort: preferredEffort(
                nextEfforts,
                selectedEffort,
                provider?.defaultReasoningEffort,
              ),
            }),
          );
        }}
        options={models.map((entry) => ({ id: entry.id, label: entry.label }))}
        value={selectedModel?.id || DEFAULT_ANALYSIS_MODEL}
      />
      {efforts.length > 0 ? (
        <CatalogSelect
          disabled={busy}
          id="default-analysis-effort"
          label="Effort"
          onValueChange={(value) =>
            onSave(
              normalizeSettingsAnalysisChoice({
                defaultAnalysisProvider: provider?.id,
                defaultAnalysisModel: selectedModel?.id,
                defaultAnalysisReasoningEffort: value,
              }),
            )
          }
          options={efforts.map((effort) => ({
            id: effort,
            label: effortLabels[effort] || effort,
          }))}
          value={selectedEffort}
        />
      ) : null}
    </div>
  );
}

export function useAnalysisCatalog() {
  const query = useQuery({
    queryKey: ["analysis-models"],
    queryFn: async ({ signal }) => {
      try {
        return await fetchAnalysisModels({ signal });
      } catch {
        return null;
      }
    },
  });

  return query.data ?? createAnalysisCatalog();
}

function CatalogSelect({ disabled, id, label, onValueChange, options, value }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Select
        disabled={disabled || options.length === 0}
        onValueChange={onValueChange}
        value={value}
      >
        <SelectTrigger id={id} className="w-full min-w-[9.5rem] sm:w-[11.5rem]" aria-label={label}>
          <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent align="end" className="h-auto max-h-72" position="popper">
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
