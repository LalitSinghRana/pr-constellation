import { runCodexExec } from "./codex-exec.js";

export function normalizeAnalysisProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (provider && provider !== "codex") {
    throw new TypeError(`Unsupported analysis provider "${value}".`);
  }
  return "codex";
}

export function inferAnalysisProvider(_model) {
  return "codex";
}

export function resolveAnalysisExecutor() {
  return runCodexExec;
}
