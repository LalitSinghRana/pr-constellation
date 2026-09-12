const DEFAULT_KILL_GRACE_MS = 1000;
const PROCESS_GROUP_POLL_MS = 20;

export const USE_DETACHED_PROCESS_GROUP = process.platform !== "win32";

/**
 * Coordinates cancellation for a spawned process and, on POSIX platforms, the
 * detached process group rooted at that child. The returned promise resolves
 * only after the direct child has closed and the process group no longer
 * exists, so callers cannot advance a sequential queue while canceled work is
 * still running.
 */
export function createChildProcessTerminator(
  child,
  { killGraceMs = DEFAULT_KILL_GRACE_MS, useProcessGroup = USE_DETACHED_PROCESS_GROUP } = {},
) {
  if (!child || typeof child.kill !== "function") {
    throw new TypeError("child must be a spawned ChildProcess.");
  }
  if (typeof killGraceMs !== "number" || !Number.isFinite(killGraceMs) || killGraceMs < 0) {
    throw new TypeError("killGraceMs must be a non-negative number.");
  }

  const childPid = Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null;
  let processGroupEnabled = Boolean(useProcessGroup && childPid && childPid !== process.pid);
  let childClosed = false;
  let forceKillTimer = null;
  let groupPollTimer = null;
  let resolved = false;
  let terminationRequested = false;
  let resolveTreeExit;
  const treeExitPromise = new Promise((resolve) => {
    resolveTreeExit = resolve;
  });

  const clearForceKillTimer = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };
  const clearGroupPollTimer = () => {
    if (groupPollTimer) {
      clearTimeout(groupPollTimer);
      groupPollTimer = null;
    }
  };
  const finish = () => {
    if (resolved) {
      return;
    }
    resolved = true;
    clearForceKillTimer();
    clearGroupPollTimer();
    resolveTreeExit();
  };
  const isProcessGroupAlive = () => {
    if (!processGroupEnabled) {
      return false;
    }

    try {
      process.kill(-childPid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      // EPERM or another unexpected probe error must not let the queue advance
      // while the process group may still exist.
      return true;
    }
  };
  const maybeFinish = () => {
    if (!childClosed) {
      return;
    }
    if (terminationRequested && isProcessGroupAlive()) {
      if (!groupPollTimer) {
        groupPollTimer = setTimeout(() => {
          groupPollTimer = null;
          maybeFinish();
        }, PROCESS_GROUP_POLL_MS);
      }
      return;
    }
    finish();
  };
  const signalProcessTree = (signalName) => {
    if (processGroupEnabled) {
      try {
        process.kill(-childPid, signalName);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") {
          return false;
        }
        // Fall back to the direct process if group signaling is unavailable.
        // Disable group polling so a permission/platform issue cannot deadlock
        // the queue after the direct child has exited.
        processGroupEnabled = false;
      }
    }

    if (childClosed) {
      return false;
    }

    try {
      return child.kill(signalName);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  };
  const forceKill = () => {
    forceKillTimer = null;
    signalProcessTree("SIGKILL");
    maybeFinish();
  };

  return {
    childClosed() {
      childClosed = true;
      maybeFinish();
    },

    terminate() {
      if (terminationRequested || resolved) {
        return;
      }
      terminationRequested = true;
      signalProcessTree("SIGTERM");
      forceKillTimer = setTimeout(forceKill, killGraceMs);
      maybeFinish();
    },

    waitForTreeExit() {
      return treeExitPromise;
    },
  };
}
