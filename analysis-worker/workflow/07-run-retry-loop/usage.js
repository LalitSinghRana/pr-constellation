export function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

export function normalizeUsage(value) {
  if (!value || typeof value !== "object") {
    return emptyUsage();
  }

  const inputTokens = nonNegativeNumber(value.inputTokens ?? value.input_tokens);
  const cachedInputTokens = nonNegativeNumber(value.cachedInputTokens ?? value.cached_input_tokens);
  const outputTokens = nonNegativeNumber(value.outputTokens ?? value.output_tokens);

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: nonNegativeNumber(
      value.totalTokens ?? value.total_tokens,
      inputTokens + outputTokens,
    ),
  };
}

export function addUsage(target, increment) {
  target.inputTokens += increment.inputTokens;
  target.cachedInputTokens += increment.cachedInputTokens;
  target.outputTokens += increment.outputTokens;
  target.totalTokens += increment.totalTokens;
  return target;
}

export function copyUsage(value) {
  return {
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  };
}

export function subtractUsage(value, baseline) {
  return {
    inputTokens: Math.max(0, value.inputTokens - baseline.inputTokens),
    cachedInputTokens: Math.max(0, value.cachedInputTokens - baseline.cachedInputTokens),
    outputTokens: Math.max(0, value.outputTokens - baseline.outputTokens),
    totalTokens: Math.max(0, value.totalTokens - baseline.totalTokens),
  };
}

function nonNegativeNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
