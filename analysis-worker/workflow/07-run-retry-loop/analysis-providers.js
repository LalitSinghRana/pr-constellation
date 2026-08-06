import {
  inferAnalysisProvider as inferProviderFromModel,
  normalizeAnalysisProvider as normalizeProviderName,
} from "../../../shared/analysis-models.js";
import { runClaudeExec } from "./claude-agent.js";
import { runCodexExec } from "./codex-exec.js";
import { runCursorAgentExec } from "./cursor-agent.js";

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

export function resolveAnalysisExecutor(provider) {
  const selected = normalizeAnalysisProvider(provider);
  if (selected === "claude") {
    return runClaudeExec;
  }
  if (selected === "cursor") {
    return runCursorAgentExec;
  }
  return runCodexExec;
}
