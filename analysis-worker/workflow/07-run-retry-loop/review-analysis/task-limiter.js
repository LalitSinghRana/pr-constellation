import { throwIfAborted } from "../../abort.js";

export function createTaskLimiter(maxConcurrency) {
  let activeCount = 0;
  const waiting = [];

  return async (task, signal) => {
    throwIfAborted(signal);
    if (activeCount < maxConcurrency) {
      activeCount += 1;
    } else {
      await new Promise((resolve, reject) => {
        const waiter = { resolve, signal };
        const onAbort = () => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          try {
            throwIfAborted(signal);
          } catch (error) {
            reject(error);
          }
        };
        waiter.onAbort = onAbort;
        waiting.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }

    try {
      throwIfAborted(signal);
      return await task();
    } finally {
      const startNext = waiting.shift();
      if (startNext) {
        startNext.signal?.removeEventListener("abort", startNext.onAbort);
        startNext.resolve();
      } else {
        activeCount -= 1;
      }
    }
  };
}

export async function runCancelableFanout({ limitTask, signal, tasks }) {
  throwIfAborted(signal);
  const siblingController = new AbortController();
  const taskSignal = signal
    ? AbortSignal.any([signal, siblingController.signal])
    : siblingController.signal;
  let firstError;

  const settlements = await Promise.allSettled(
    tasks.map((task) =>
      limitTask(async () => {
        try {
          return await task(taskSignal);
        } catch (error) {
          if (!firstError) {
            firstError = error;
            siblingController.abort(error);
          }
          throw error;
        }
      }, taskSignal),
    ),
  );

  throwIfAborted(signal);
  if (firstError) throw firstError;
  return settlements.map((settlement) => settlement.value);
}
