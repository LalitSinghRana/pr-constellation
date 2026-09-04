import {
  inferAnalysisProvider as inferProviderFromModel,
  normalizeAnalysisProvider as normalizeProviderName,
} from "../../../shared/analysis-models.js";
import { runClaudeExec } from "./claude-agent.js";
import { runCodexExec } from "./codex-exec.js";
import { runCursorAgentExec, serializeCursorExecutor } from "./cursor-agent.js";

export function normalizeAnalysisProvider(value) {
  const provider = normalizeProviderName(value);
  if (!provider) {
    throw new TypeError(`Unsupported analysis provider "${value}".`);
  }
  return provider;
}

export function inferAnalysisProvider(model) {
  return inferProviderFromModel(model);
}

export function resolveAnalysisExecutor({ model, provider } = {}) {
  const selected = provider ? normalizeAnalysisProvider(provider) : inferAnalysisProvider(model);
  if (selected === "claude") {
    return runClaudeExec;
  }
  if (selected === "codex") {
    return runCodexExec;
  }
  if (selected === "cursor") {
    return serializeCursorExecutor(runCursorAgentExec);
  }
  throw new TypeError(`Unsupported analysis provider "${selected}".`);
}
