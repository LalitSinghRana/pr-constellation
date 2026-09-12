export function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }

  throw createAbortError(signal.reason);
}

export function createAbortError(reason) {
  const message =
    reason instanceof Error && reason.message ? reason.message : "The operation was aborted.";
  const error = new Error(message, reason === undefined ? undefined : { cause: reason });
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}
