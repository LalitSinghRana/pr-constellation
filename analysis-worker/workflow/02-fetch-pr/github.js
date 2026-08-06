import { spawn } from "node:child_process";
import {
  createChildProcessTerminator,
  USE_DETACHED_PROCESS_GROUP,
} from "../child-process-termination.js";

const MAX_SNAPSHOT_ATTEMPTS = 3;
const GH_MAX_BUFFER_BYTES = 1024 * 1024 * 100;

export function parseGitHubPrUrl(prUrl) {
  let parsed;

  try {
    parsed = new URL(prUrl);
  } catch {
    throw new Error(`Expected a GitHub pull request URL, got: ${prUrl}`);
  }

  if (parsed.hostname !== "github.com") {
    throw new Error(`Expected a github.com URL, got: ${prUrl}`);
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const [owner, repo, pull, number] = parts;
  const numericNumber = Number(number);

  if (
    !owner ||
    !repo ||
    pull !== "pull" ||
    !number ||
    !/^\d+$/.test(number) ||
    !Number.isSafeInteger(numericNumber) ||
    numericNumber < 1
  ) {
    throw new Error(`Expected a GitHub pull request URL, got: ${prUrl}`);
  }

  const canonicalNumber = String(numericNumber);
  return {
    owner,
    repo,
    number: canonicalNumber,
    slug: createReviewSlug({ owner, repo, number: canonicalNumber }),
  };
}

function createReviewSlug({ owner, repo, number }) {
  const canonicalOwner = owner.toLowerCase();
  const canonicalRepo = repo.toLowerCase();
  return [
    "gh",
    canonicalOwner.length,
    canonicalOwner,
    canonicalRepo.length,
    canonicalRepo,
    number,
  ].join("-");
}

export async function fetchPullRequest(
  prUrl,
  { executeGh = ghText, onEvent, parentStageId = "input.fetch", signal } = {},
) {
  throwIfAborted(signal);

  await runTimedGhStage({
    label: "Check GitHub CLI access",
    onEvent,
    parentStageId,
    stageId: `${parentStageId}.authenticate`,
    signal,
    task: () => ensureGhAccess(executeGh, signal),
  });

  const snapshot = await runTimedGhStage({
    getErrorMetrics: () => ({
      maxAttempts: MAX_SNAPSHOT_ATTEMPTS,
    }),
    getMetrics: ({ attempts, diff, metadata }) => ({
      additions: metadata.additions ?? 0,
      attempts,
      baseSha: metadata.baseRefOid || null,
      changedFiles: metadata.changedFiles ?? metadata.files?.length ?? 0,
      deletions: metadata.deletions ?? 0,
      headSha: metadata.headRefOid || metadata.commits?.at(-1)?.oid || null,
      outputBytes: Buffer.byteLength(diff),
      snapshotConsistent: true,
    }),
    label: "Fetch consistent PR snapshot",
    onEvent,
    parentStageId,
    signal,
    stageId: `${parentStageId}.snapshot`,
    task: () =>
      fetchConsistentSnapshot({
        executeGh,
        onEvent,
        parentStageId: `${parentStageId}.snapshot`,
        prUrl,
        signal,
      }),
  });

  return {
    metadata: snapshot.metadata,
    diff: snapshot.diff,
  };
}

async function fetchConsistentSnapshot({ executeGh, onEvent, parentStageId, prUrl, signal }) {
  let lastSnapshotChange;

  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const attemptStageId = `${parentStageId}.attempt-${attempt}`;

    try {
      return await runTimedGhStage({
        getErrorMetrics: (error) => ({
          attempt,
          ...snapshotChangeMetrics(error),
          willRetry: error instanceof SnapshotChangedError && attempt < MAX_SNAPSHOT_ATTEMPTS,
        }),
        getMetrics: ({ metadata }) => ({
          attempt,
          baseSha: metadata.baseRefOid,
          headSha: metadata.headRefOid,
          snapshotConsistent: true,
          willRetry: false,
        }),
        label: `Fetch PR snapshot attempt ${attempt}`,
        onEvent,
        parentStageId,
        signal,
        stageId: attemptStageId,
        task: async () => {
          const metadataBefore = await fetchMetadata({
            executeGh,
            label: "Fetch PR metadata before diff",
            onEvent,
            parentStageId: attemptStageId,
            prUrl,
            signal,
            stageId: `${attemptStageId}.metadata-before`,
          });
          const diff = await runTimedGhStage({
            getMetrics: (value) => ({ outputBytes: Buffer.byteLength(value) }),
            label: "Fetch PR diff",
            onEvent,
            parentStageId: attemptStageId,
            signal,
            stageId: `${attemptStageId}.diff`,
            task: () => executeGh(["pr", "diff", prUrl], { signal }),
          });
          const metadataAfter = await fetchMetadata({
            executeGh,
            label: "Verify PR metadata after diff",
            onEvent,
            parentStageId: attemptStageId,
            prUrl,
            signal,
            stageId: `${attemptStageId}.metadata-after`,
          });

          await runTimedGhStage({
            getErrorMetrics: snapshotChangeMetrics,
            getMetrics: (refs) => ({
              ...refs,
              snapshotConsistent: true,
            }),
            label: "Verify PR refs stayed stable",
            onEvent,
            parentStageId: attemptStageId,
            signal,
            stageId: `${attemptStageId}.verify-refs`,
            task: () => verifyMatchingRefs(metadataBefore, metadataAfter),
          });

          return {
            attempts: attempt,
            diff,
            metadata: metadataAfter,
          };
        },
      });
    } catch (error) {
      if (!(error instanceof SnapshotChangedError)) {
        throw error;
      }

      lastSnapshotChange = error;
      if (attempt === MAX_SNAPSHOT_ATTEMPTS) {
        break;
      }
    }
  }

  throw new Error(
    [
      `GitHub PR refs changed during ${MAX_SNAPSHOT_ATTEMPTS} consecutive snapshot attempts.`,
      "Retry once pushes to the PR or its base branch have stopped.",
      lastSnapshotChange?.message,
    ]
      .filter(Boolean)
      .join(" "),
    { cause: lastSnapshotChange },
  );
}

function fetchMetadata({ executeGh, label, onEvent, parentStageId, prUrl, signal, stageId }) {
  return runTimedGhStage({
    getMetrics: (value) => ({
      additions: value.additions ?? 0,
      baseSha: value.baseRefOid || null,
      changedFiles: value.changedFiles ?? value.files?.length ?? 0,
      deletions: value.deletions ?? 0,
      headSha: value.headRefOid || value.commits?.at(-1)?.oid || null,
    }),
    label,
    onEvent,
    parentStageId,
    signal,
    stageId,
    task: () =>
      ghJson(
        [
          "pr",
          "view",
          prUrl,
          "--json",
          [
            "additions",
            "author",
            "baseRefName",
            "baseRefOid",
            "body",
            "changedFiles",
            "commits",
            "deletions",
            "files",
            "headRefName",
            "headRefOid",
            "number",
            "state",
            "title",
            "url",
          ].join(","),
        ],
        executeGh,
        signal,
      ),
  });
}

function verifyMatchingRefs(metadataBefore, metadataAfter) {
  const before = readSnapshotRefs(metadataBefore);
  const after = readSnapshotRefs(metadataAfter);

  if (before.baseSha !== after.baseSha || before.headSha !== after.headSha) {
    throw new SnapshotChangedError(before, after);
  }

  return after;
}

function readSnapshotRefs(metadata) {
  const baseSha = metadata.baseRefOid;
  const headSha = metadata.headRefOid;

  if (
    typeof baseSha !== "string" ||
    baseSha.length === 0 ||
    typeof headSha !== "string" ||
    headSha.length === 0
  ) {
    throw new Error(
      "GitHub did not return baseRefOid and headRefOid; cannot verify the PR snapshot.",
    );
  }

  return { baseSha, headSha };
}

function snapshotChangeMetrics(error) {
  if (!(error instanceof SnapshotChangedError)) {
    return {};
  }

  return {
    baseShaAfter: error.after.baseSha,
    baseShaBefore: error.before.baseSha,
    headShaAfter: error.after.headSha,
    headShaBefore: error.before.headSha,
    snapshotConsistent: false,
  };
}

class SnapshotChangedError extends Error {
  constructor(before, after) {
    super(
      `PR refs moved from ${before.baseSha}/${before.headSha} ` +
        `to ${after.baseSha}/${after.headSha} while fetching its diff.`,
    );
    this.name = "SnapshotChangedError";
    this.before = before;
    this.after = after;
  }
}

async function ensureGhAccess(executeGh, signal) {
  try {
    await executeGh(["--version"], { signal });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error("GitHub CLI is required. Install `gh`, then run `gh auth login`.");
  }

  try {
    await executeGh(["auth", "status"], { signal });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error("GitHub CLI is not authenticated. Run `gh auth login`, then retry `prc`.");
  }
}

async function ghJson(args, executeGh = ghText, signal) {
  const text = await executeGh(args, { signal });
  return JSON.parse(text);
}

export async function ghText(args, { signal } = {}) {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      detached: USE_DETACHED_PROCESS_GROUP,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminator = createChildProcessTerminator(child);
    let outputFailure = null;
    let settled = false;
    let stderr = "";
    let stdout = "";

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      terminator.terminate();
    };
    const appendOutput = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next) > GH_MAX_BUFFER_BYTES) {
        outputFailure ||= new Error(
          `gh ${args.join(" ")} exceeded the ${GH_MAX_BUFFER_BYTES}-byte output limit.`,
        );
        terminator.terminate();
        return current;
      }
      return next;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (child.pid) {
        return;
      }
      terminator.childClosed();
      if (signal?.aborted) {
        rejectOnce(createAbortError(signal.reason));
        return;
      }
      rejectOnce(new Error(`Failed to start gh: ${error.message}`));
    });
    child.on("close", async (code) => {
      terminator.childClosed();
      await terminator.waitForTreeExit();
      if (settled) {
        return;
      }
      if (signal?.aborted) {
        rejectOnce(createAbortError(signal.reason));
        return;
      }
      if (outputFailure) {
        rejectOnce(outputFailure);
        return;
      }
      if (code === 0) {
        resolveOnce(stdout);
        return;
      }

      const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
      rejectOnce(new Error(`gh ${args.join(" ")} failed:\n${detail}`));
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

async function runTimedGhStage({
  getErrorMetrics = () => ({}),
  getMetrics = () => ({}),
  label,
  onEvent,
  parentStageId,
  signal,
  stageId,
  task,
}) {
  const startedNs = process.hrtime.bigint();

  await emitRunEvent(onEvent, {
    at: new Date().toISOString(),
    label,
    parentStageId,
    stageId,
    type: "stage-start",
  });

  try {
    throwIfAborted(signal);
    const result = await task();
    throwIfAborted(signal);
    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;

    await emitRunEvent(onEvent, {
      at: new Date().toISOString(),
      metrics: {
        ...getMetrics(result),
        elapsedMs,
      },
      parentStageId,
      stageId,
      status: "completed",
      type: "stage-finish",
    });
    return result;
  } catch (error) {
    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;

    await emitRunEvent(onEvent, {
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      metrics: {
        ...getErrorMetrics(error),
        elapsedMs,
      },
      parentStageId,
      stageId,
      status: isAbortError(error) ? "canceled" : "failed",
      type: "stage-finish",
    });
    throw error;
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }

  throw createAbortError(signal.reason);
}

function createAbortError(reason) {
  const message =
    reason instanceof Error && reason.message ? reason.message : "The operation was aborted.";
  const error = new Error(message, reason === undefined ? undefined : { cause: reason });
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

async function emitRunEvent(onEvent, event) {
  if (onEvent) {
    await onEvent(event);
  }
}
