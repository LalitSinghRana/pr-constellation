import { performance } from "node:perf_hooks";
import { normalizeTokenUsage } from "./configuration.js";
import {
  readInputFingerprint,
  resolveFrozenInputFingerprint,
  tryReadInputFingerprint,
} from "./input-snapshot.js";
import {
  ACTIVE_STATUSES,
  cancellationEventError,
  createAbortError,
  isAbortError,
  isStageFinishEvent,
  resolveBaseSha,
  resolveHeadSha,
  throwIfAborted,
} from "./run-ids.js";
import { eventForResumedJob } from "./run-resume.js";

export async function executeJob(ctx, job) {
  const runDir = ctx.store.getRunDir(job.slug, job.runId);
  const startedNs = performance.now();
  const signal = job.abortController.signal;
  let completedResult = null;
  let successCommitted = false;
  let totalStageStarted = false;

  const trackPendingWrite = (pendingWrite) => {
    job.pendingEventWrites.add(pendingWrite);
    pendingWrite
      .finally(() => {
        job.pendingEventWrites.delete(pendingWrite);
      })
      .catch(() => {});
    return pendingWrite;
  };

  const onEvent = (event) => {
    return trackPendingWrite(recordEvent(event));
  };

  const recordEvent = async (event) => {
    const resumedEvent = eventForResumedJob(job, event);
    const canceledFinish = signal.aborted && isStageFinishEvent(resumedEvent);
    if (signal.aborted && !canceledFinish) {
      return;
    }
    const cancellationEvent = canceledFinish
      ? {
          ...resumedEvent,
          error: cancellationEventError(resumedEvent.error),
          status: "canceled",
        }
      : resumedEvent;
    const normalizedEvent =
      cancellationEvent.stageId !== "run.total" && !cancellationEvent.parentStageId
        ? { ...cancellationEvent, parentStageId: "run.total" }
        : cancellationEvent;

    await ctx.store.recordStageEvent(job.slug, job.runId, normalizedEvent);

    if (normalizedEvent.type === "stage-start" && !signal.aborted) {
      await ctx.store.updateRun(job.slug, job.runId, {
        phase: normalizedEvent.label || normalizedEvent.stageId,
      });
    } else if (normalizedEvent.type === "stage-finish") {
      await updateLiveMetrics(ctx, job, normalizedEvent);
    }
    ctx.emitChange({ runId: job.runId, slug: job.slug, type: "progress" });
  };

  try {
    throwIfAborted(signal);
    const codeVersion = await ctx.getCodeVersion({ cwd: ctx.projectRoot });
    throwIfAborted(signal);
    const startedAt = ctx.nowDate();

    await ctx.store.updateRun(job.slug, job.runId, {
      error: null,
      gitCommit: codeVersion.commit,
      metrics: {
        codeDirty: codeVersion.dirty,
        codeFingerprint: codeVersion.fingerprint,
      },
      phase: "Starting analysis",
      status: "running",
      timestamps: {
        startedAt,
      },
    });
    throwIfAborted(signal);
    await trackPendingWrite(
      ctx.store.recordStageEvent(
        job.slug,
        job.runId,
        eventForResumedJob(job, {
          at: startedAt.toISOString(),
          label: "Total analysis run",
          stageId: "run.total",
          type: "stage-start",
        }),
      ),
    );
    totalStageStarted = true;
    throwIfAborted(signal);

    const frozenSource = job.sourceRunId
      ? await ctx.store.resolveFrozenSource({
          slug: job.slug,
          sourceRunId: job.sourceRunId,
        })
      : null;
    const sourceRunDir = frozenSource?.runDir || null;
    if (frozenSource) {
      const sourceFingerprint = await resolveFrozenInputFingerprint(frozenSource);
      await ctx.store.updateRun(job.slug, job.runId, {
        ...(frozenSource.run.baseSha ? { baseSha: frozenSource.run.baseSha } : {}),
        ...(frozenSource.run.headSha ? { headSha: frozenSource.run.headSha } : {}),
        metrics: {
          inputFingerprint: sourceFingerprint,
        },
        title: frozenSource.run.title || "",
      });
    }
    throwIfAborted(signal);

    const result = await ctx.runExecutor({
      model: job.model,
      onEvent,
      prUrl: job.prUrl,
      provider: job.provider,
      reasoningEffort: job.reasoningEffort,
      reviewsDir: ctx.reviewsDir,
      runDir,
      signal,
      sourceRunDir,
    });
    completedResult = result;
    throwIfAborted(signal);
    const inputFingerprint = await readInputFingerprint(runDir);
    const usage = normalizeTokenUsage(result.usage);
    const completedAt = ctx.nowDate();
    const elapsedMs = Math.round((performance.now() - startedNs) * 1000) / 1000;
    throwIfAborted(signal);

    await trackPendingWrite(
      ctx.store.recordStageEvent(
        job.slug,
        job.runId,
        eventForResumedJob(job, {
          at: completedAt.toISOString(),
          metrics: { elapsedMs },
          stageId: "run.total",
          status: "completed",
          type: "stage-finish",
        }),
      ),
    );
    throwIfAborted(signal);
    await ctx.store.updateRun(job.slug, job.runId, (current) => {
      if (signal.aborted || !ACTIVE_STATUSES.has(current.status)) {
        return {};
      }
      successCommitted = true;
      return {
        baseSha: resolveBaseSha(result.metadata),
        error: null,
        headSha: resolveHeadSha(result.metadata),
        metrics: {
          additions: result.metadata?.additions ?? 0,
          changedFiles: result.metadata?.changedFiles ?? result.diffSummary?.files?.length ?? 0,
          changedLines: result.diffSummary?.changedLineCount ?? 0,
          deletions: result.metadata?.deletions ?? 0,
          inputFingerprint,
          totalMs: elapsedMs,
          ...(usage ? { tokens: usage, usage } : {}),
        },
        phase: "Complete",
        status: "succeeded",
        timestamps: {
          completedAt,
        },
        title: result.metadata?.title || "",
      };
    });
    if (!successCommitted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : createAbortError("Analysis was canceled before success could be committed.");
    }

    ctx.emitChange({ runId: job.runId, slug: job.slug, type: "succeeded" });
  } catch (error) {
    const inputFingerprint = await tryReadInputFingerprint(runDir);
    const usage = normalizeTokenUsage(error?.usage || completedResult?.usage);
    const completedAt = ctx.nowDate();
    const elapsedMs = Math.round((performance.now() - startedNs) * 1000) / 1000;
    const message = error instanceof Error ? error.message : String(error);
    const canceled = !successCommitted && (signal.aborted || isAbortError(error));
    const errorDetails = canceled
      ? {
          code: "RUN_CANCELED",
          message: message || "Analysis was canceled.",
          ...(typeof error?.code === "string" ? { causeCode: error.code } : {}),
        }
      : {
          code: "RUN_FAILED",
          message,
        };

    if (totalStageStarted) {
      await trackPendingWrite(
        ctx.store.recordStageEvent(
          job.slug,
          job.runId,
          eventForResumedJob(job, {
            at: completedAt.toISOString(),
            error: errorDetails,
            metrics: { elapsedMs },
            stageId: "run.total",
            status: canceled ? "canceled" : "failed",
            type: "stage-finish",
          }),
        ),
      );
    }
    await ctx.store.updateRun(job.slug, job.runId, (current) => {
      const canFinalize =
        ACTIVE_STATUSES.has(current.status) ||
        (canceled && current.status === "canceled") ||
        (successCommitted && current.status === "succeeded");
      if (!canFinalize) {
        return {};
      }

      return {
        error: errorDetails,
        metrics: {
          ...(inputFingerprint ? { inputFingerprint } : {}),
          totalMs: elapsedMs,
          ...(usage ? { tokens: usage, usage } : {}),
        },
        phase: canceled ? "Canceled" : "Failed",
        status: canceled ? "canceled" : "failed",
        timestamps: {
          completedAt,
        },
      };
    });
    ctx.emitChange({
      runId: job.runId,
      slug: job.slug,
      type: canceled ? "canceled" : "failed",
    });
  }
}

export async function markRunCanceled(ctx, job, { message }) {
  const completedAt = ctx.nowDate();
  let transitioned = false;
  const updated = await ctx.store.updateRun(job.slug, job.runId, (current) => {
    if (current.status === "canceled" && current.error?.code === "RUN_CANCELED") {
      transitioned = true;
      return {};
    }
    if (!ACTIVE_STATUSES.has(current.status)) {
      return {};
    }
    transitioned = true;
    return {
      error: {
        code: "RUN_CANCELED",
        message,
      },
      phase: "Canceled",
      status: "canceled",
      timestamps: {
        completedAt,
      },
    };
  });
  if (transitioned) ctx.emitChange({ runId: job.runId, slug: job.slug, type: "canceled" });
  return transitioned ? updated : null;
}

export async function cancelOpenStages(ctx, job, { message }) {
  if (job.pendingEventWrites?.size > 0) {
    await Promise.allSettled([...job.pendingEventWrites]);
  }

  let timings;
  try {
    timings = await ctx.store.readTimings(job.slug, job.runId);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const stagesToCancel = timings.stages
    .filter(
      (stage) => !stage.endedAt || (stage.stageId === "run.total" && stage.status !== "canceled"),
    )
    .reverse();
  if (stagesToCancel.length === 0) {
    return;
  }

  const canceledAt = ctx.nowDate().toISOString();
  for (const stage of stagesToCancel) {
    await ctx.store.recordStageEvent(job.slug, job.runId, {
      at: canceledAt,
      attempt: stage.attempt,
      error: {
        code: "RUN_CANCELED",
        message,
      },
      label: stage.label,
      parentStageId: stage.parentStageId,
      stageId: stage.stageId,
      status: "canceled",
      type: "stage-finish",
    });
  }
}

export async function updateLiveMetrics(ctx, job, event) {
  const metrics = event.metrics || {};
  const patch = {};

  if (event.stageId === "input.fetch.snapshot" || event.stageId === "input.fetch.metadata") {
    patch.headSha = metrics.headSha || null;
    patch.metrics = {
      additions: metrics.additions ?? 0,
      changedFiles: metrics.changedFiles ?? 0,
      deletions: metrics.deletions ?? 0,
    };
  } else if (event.stageId === "inventory") {
    patch.metrics = {
      changedFiles: metrics.fileCount ?? 0,
      changedLines: metrics.changedLineCount ?? 0,
    };
  }

  if (Object.keys(patch).length > 0) {
    await ctx.store.updateRun(job.slug, job.runId, patch);
  }
}
