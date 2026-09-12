const defaultPollIntervalMs = 5 * 60_000;
const maximumRetryMs = 15 * 60_000;

export function createSyncScheduler({
  clearTimer = clearTimeout,
  onError = (error) => console.error("GitHub synchronization failed:", error),
  onUpdate = () => {},
  pollIntervalMs = defaultPollIntervalMs,
  setTimer = setTimeout,
  sync,
}) {
  if (typeof sync !== "function") {
    throw new TypeError("sync is required.");
  }

  let failures = 0;
  let nextPollMs = pollIntervalMs;
  let retryAfterMs = 0;
  let running = null;
  let stopping = false;
  let stopped = true;
  let timer = null;

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => runNow().catch(() => {}), delayMs);
    timer?.unref?.();
  }

  async function execute() {
    try {
      const result = await sync();
      failures = 0;
      retryAfterMs = 0;
      nextPollMs = Number.isInteger(result?.pollIntervalSeconds)
        ? Math.max(1_000, result.pollIntervalSeconds * 1_000)
        : pollIntervalMs;
      onUpdate({ result });
      return result;
    } catch (error) {
      failures += 1;
      retryAfterMs = Number.isInteger(error?.retryAfterMs) ? error.retryAfterMs : 0;
      onError(error);
      throw error;
    } finally {
      running = null;
      const retryMs = Math.min(nextPollMs * 2 ** Math.max(0, failures - 1), maximumRetryMs);
      schedule(failures ? Math.max(retryMs, retryAfterMs) : nextPollMs);
    }
  }

  function runNow() {
    if (stopping) return Promise.resolve();
    if (!running) running = execute();
    return running;
  }

  return {
    runNow,
    runSync: runNow,
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
      return running?.catch(() => {}) ?? Promise.resolve();
    },
  };
}
