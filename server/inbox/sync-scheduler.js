const defaultNotificationIntervalMs = 5 * 60_000;
const defaultReconciliationIntervalMs = 60 * 60_000;
const maximumRetryMs = 15 * 60_000;

function backoffDelayMs({ failures, nextPollMs, retryAfterMs }) {
  const exponential = nextPollMs * 2 ** Math.max(0, failures - 1);
  const capped = Math.min(exponential, maximumRetryMs);
  return failures ? Math.max(capped, retryAfterMs) : nextPollMs;
}

function resolvePollIntervalMs(result, fallbackMs) {
  return Number.isInteger(result?.pollIntervalSeconds)
    ? Math.max(1_000, result.pollIntervalSeconds * 1_000)
    : fallbackMs;
}

export function createSyncScheduler({
  clearTimer = clearTimeout,
  fullSync,
  notificationIntervalMs = defaultNotificationIntervalMs,
  notificationSync,
  now = Date.now,
  onError = (error) => console.error("GitHub synchronization failed:", error),
  onUpdate = () => {},
  reconciliationIntervalMs = defaultReconciliationIntervalMs,
  setTimer = setTimeout,
}) {
  if (typeof fullSync !== "function" || typeof notificationSync !== "function") {
    throw new TypeError("fullSync and notificationSync are required.");
  }

  let failures = 0;
  let nextPollMs = notificationIntervalMs;
  let nextFullSyncAt = 0;
  let retryAfterMs = 0;
  let queuedFullSync = null;
  let running = null;
  let runningFull = false;
  let stopping = false;
  let stopped = true;
  let timer = null;

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => runNow().catch(() => {}), delayMs);
    timer?.unref?.();
  }

  async function execute(full) {
    try {
      const result = await (full ? fullSync() : notificationSync());
      failures = 0;
      retryAfterMs = 0;
      nextPollMs = resolvePollIntervalMs(result, notificationIntervalMs);
      if (full) nextFullSyncAt = now() + reconciliationIntervalMs;
      onUpdate({ full, result });
      return result;
    } catch (error) {
      failures += 1;
      retryAfterMs = Number.isInteger(error?.retryAfterMs) ? error.retryAfterMs : 0;
      onError(error);
      throw error;
    } finally {
      running = null;
      runningFull = false;
      const retryMs = backoffDelayMs({ failures, nextPollMs, retryAfterMs });
      schedule(retryMs);
    }
  }

  function runNow() {
    if (stopping) return Promise.resolve();
    if (!running) {
      runningFull = now() >= nextFullSyncAt;
      running = execute(runningFull);
    }
    return running;
  }

  function runFullSync() {
    if (stopping) return Promise.resolve();
    if (running && !runningFull) {
      queuedFullSync ??= running
        .then(() => (stopping ? undefined : runFullSync()))
        .finally(() => {
          queuedFullSync = null;
        });
      return queuedFullSync;
    }
    if (!running) {
      runningFull = true;
      running = execute(true);
    }
    return running;
  }

  function runNotificationSync() {
    if (stopping) return Promise.resolve();
    if (!running) {
      runningFull = false;
      running = execute(false);
    }
    return running;
  }

  return {
    runNow,
    runFullSync,
    runNotificationSync,
    start() {
      if (!stopped) return;
      stopping = false;
      stopped = false;
      schedule(0);
    },
    stop() {
      stopping = true;
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      return (queuedFullSync ?? running)?.catch(() => {}) ?? Promise.resolve();
    },
  };
}
