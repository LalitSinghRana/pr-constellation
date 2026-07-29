export function groupRunsForDisplay(runs) {
  const groups = new Map();

  for (const [inputIndex, run] of (Array.isArray(runs) ? runs : []).entries()) {
    const batchId = readBatchId(run);
    const key = batchId
      ? `batch:${batchId}`
      : `run:${readRunId(run) || "unknown"}:${inputIndex}`;
    let group = groups.get(key);

    if (!group) {
      group = {
        batchId: batchId || null,
        firstInputIndex: inputIndex,
        key,
        latestTimestamp: 0,
        runs: [],
      };
      groups.set(key, group);
    }

    group.latestTimestamp = Math.max(
      group.latestTimestamp,
      readRunTimestamp(run),
    );
    group.runs.push(run);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      runs: group.batchId
        ? [...group.runs].sort(compareBatchMembers)
        : [...group.runs],
    }))
    .sort((left, right) => (
      right.latestTimestamp - left.latestTimestamp
      || left.key.localeCompare(right.key)
      || left.firstInputIndex - right.firstInputIndex
    ))
    .map(({ firstInputIndex: _firstInputIndex, ...group }) => group);
}

function compareBatchMembers(left, right) {
  const leftIndex = readBatchIndex(left);
  const rightIndex = readBatchIndex(right);

  if (leftIndex != null || rightIndex != null) {
    if (leftIndex == null) {
      return 1;
    }
    if (rightIndex == null) {
      return -1;
    }
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
  }

  return (
    readRunTimestamp(left) - readRunTimestamp(right)
    || readRunId(left).localeCompare(readRunId(right))
  );
}

function readBatchId(run) {
  const batchId = run?.batchId || run?.metrics?.batchId;
  return typeof batchId === "string" && batchId ? batchId : "";
}

function readBatchIndex(run) {
  for (const value of [run?.batchIndex, run?.metrics?.batchIndex]) {
    if (value !== "" && value != null && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function readRunId(run) {
  return String(run?.runId || run?.id || "");
}

function readRunTimestamp(run) {
  for (const value of [
    run?.startedAt,
    run?.timestamps?.startedAt,
    run?.queuedAt,
    run?.timestamps?.queuedAt,
    run?.createdAt,
    run?.timestamps?.createdAt,
    run?.updatedAt,
    run?.timestamps?.updatedAt,
    run?.finishedAt,
    run?.timestamps?.finishedAt,
    run?.completedAt,
    run?.timestamps?.completedAt,
  ]) {
    if (!value) {
      continue;
    }
    const timestamp = typeof value === "number" ? value : Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return 0;
}
