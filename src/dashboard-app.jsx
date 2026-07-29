import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileCode2,
  Gauge,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  TimerReset,
  Trash2,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog.jsx";
import { Badge } from "./components/ui/badge.jsx";
import { Button } from "./components/ui/button.jsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible.jsx";
import { Input } from "./components/ui/input.jsx";
import { Progress } from "./components/ui/progress.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.jsx";

const FAST_POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const SUCCESS_STATUSES = new Set(["complete", "completed", "success", "succeeded"]);
const FAILURE_STATUSES = new Set(["error", "failed", "failure", "interrupted", "cancelled", "canceled"]);

export function DashboardApp({ apiBase = "/api" }) {
  const [dashboard, setDashboard] = useState({
    configuration: {},
    prs: [],
    queue: {},
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [mutation, setMutation] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const [selectedModel, setSelectedModel] = useState("");

  const prs = useMemo(() => sortPullRequests(dashboard.prs || []), [dashboard.prs]);
  const modelOptions = useMemo(() => {
    const configured = Array.isArray(dashboard.configuration?.models)
      ? dashboard.configuration.models
      : [];
    const defaultModel = dashboard.configuration?.defaultModel;
    return [...new Set([
      ...configured.filter((model) => typeof model === "string" && model.trim()),
      ...(typeof defaultModel === "string" && defaultModel.trim() ? [defaultModel] : []),
    ])];
  }, [dashboard.configuration]);
  const hasActiveRun = useMemo(() => {
    if (dashboard.queue?.activeRunId || dashboard.queue?.queuedRunIds?.length) {
      return true;
    }
    return prs.some((pr) => (pr.runs || []).some((run) => ACTIVE_STATUSES.has(normalizeStatus(run.status))));
  }, [dashboard.queue, prs]);

  const loadDashboard = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) {
      setRefreshing(true);
    }
    try {
      const response = await fetch(`${apiBase}/dashboard`, {
        headers: { Accept: "application/json" },
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new Error(body?.error || body?.message || `Dashboard request failed (${response.status})`);
      }
      setDashboard({
        configuration: body?.configuration || {},
        prs: Array.isArray(body?.prs)
          ? body.prs
          : Array.isArray(body?.pullRequests) ? body.pullRequests : [],
        queue: body?.queue || {},
      });
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiBase]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!modelOptions.length) {
      return;
    }
    setSelectedModel((current) => (
      current && modelOptions.includes(current)
        ? current
        : dashboard.configuration?.defaultModel || modelOptions[0]
    ));
  }, [dashboard.configuration?.defaultModel, modelOptions]);

  useEffect(() => {
    const interval = window.setInterval(
      () => loadDashboard({ quiet: true }),
      hasActiveRun ? FAST_POLL_MS : IDLE_POLL_MS,
    );
    return () => window.clearInterval(interval);
  }, [hasActiveRun, loadDashboard]);

  useEffect(() => {
    if (!hasActiveRun) {
      return undefined;
    }
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasActiveRun]);

  const createRun = useCallback(async (prUrl, { refresh = false } = {}) => {
    const mutationId = refresh ? `refresh:${prUrl}` : "create";
    setMutation(mutationId);
    setNotice("");
    try {
      const response = await fetch(`${apiBase}/runs`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          prUrl,
          ...(refresh ? { refresh: true } : {}),
        }),
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new Error(body?.error || body?.message || `Could not start analysis (${response.status})`);
      }
      setNotice(
        `${refresh ? "Fresh GitHub snapshot" : "Analysis"} queued on ${selectedModel}.`,
      );
      await loadDashboard({ quiet: true });
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
      return false;
    } finally {
      setMutation("");
    }
  }, [apiBase, loadDashboard, selectedModel]);

  const rerun = useCallback(async ({ prSlug = "", runId = "" }) => {
    const mutationId = `rerun:${prSlug}:${runId}`;
    const endpoint = `${apiBase}/runs/${encodeURIComponent(prSlug)}/${encodeURIComponent(runId)}/rerun`;
    setMutation(mutationId);
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: selectedModel }),
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new Error(body?.error || body?.message || `Could not queue rerun (${response.status})`);
      }
      setNotice(`Frozen benchmark queued on ${selectedModel}.`);
      await loadDashboard({ quiet: true });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setMutation("");
    }
  }, [apiBase, loadDashboard, selectedModel]);

  const deleteHistory = useCallback(async ({ prSlug = "", runId = "" }) => {
    const mutationId = `delete:run:${prSlug}:${runId}`;
    const endpoint = `${apiBase}/runs/${encodeURIComponent(prSlug)}/${encodeURIComponent(runId)}`;

    setMutation(mutationId);
    setError("");
    setNotice("");

    try {
      const response = await fetch(endpoint, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new Error(
          body?.error
          || body?.message
          || `Could not delete run history (${response.status})`,
        );
      }
      await loadDashboard({ quiet: true });
      setNotice("Analysis run deleted from history.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setMutation("");
    }
  }, [apiBase, loadDashboard]);

  const cancelAnalysis = useCallback(async ({ prSlug, runId }) => {
    const mutationId = `cancel:run:${prSlug}:${runId}`;
    const endpoint = `${apiBase}/runs/${encodeURIComponent(prSlug)}/${encodeURIComponent(runId)}/cancel`;

    setMutation(mutationId);
    setError("");
    setNotice("");

    let actionError = "";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new Error(
          body?.error
          || body?.message
          || `Could not cancel run (${response.status})`,
        );
      }
    } catch (requestError) {
      actionError = requestError instanceof Error ? requestError.message : String(requestError);
    }

    await loadDashboard({ quiet: true });
    if (actionError) {
      setError(actionError);
    } else {
      setNotice("Analysis run cancelled.");
    }
    setMutation("");
  }, [apiBase, loadDashboard]);

  const stats = dashboardStats(prs, now);

  return (
    <div className="benchmark-shell">
      <header className="benchmark-header">
        <a className="benchmark-brand" href="/" aria-label="PR Review Cockpit home">
          <span className="benchmark-brand-mark" aria-hidden="true">
            <GitPullRequest />
          </span>
          <span>
            <span className="benchmark-brand-name">PR Review Cockpit</span>
            <span className="benchmark-brand-caption">Analysis benchmark</span>
          </span>
        </a>
        <div className="benchmark-header-actions">
          <div className="benchmark-persistence-note">
            <Check aria-hidden="true" />
            Runs saved locally
          </div>
          <Button
            className="benchmark-icon-button"
            variant="outline"
            size="icon"
            aria-label="Refresh dashboard"
            disabled={refreshing}
            onClick={() => loadDashboard()}
          >
            <RefreshCw className={refreshing ? "benchmark-spin" : ""} />
          </Button>
        </div>
      </header>

      <main className="benchmark-main">
        <section className="benchmark-intro">
          <div>
            <p className="benchmark-kicker">
              <Activity aria-hidden="true" />
              Local performance lab
            </p>
            <h1>Make every review run faster.</h1>
            <p className="benchmark-lede">
              Generate an analysis, inspect where its time went, then compare the next run against
              the same frozen PR input.
            </p>
          </div>
          <OverviewStats stats={stats} />
        </section>

        <NewAnalysisForm
          busy={mutation === "create"}
          model={selectedModel}
          modelProviders={dashboard.configuration?.modelProviders || {}}
          models={modelOptions}
          onModelChange={setSelectedModel}
          onSubmit={createRun}
        />

        <div className="benchmark-feedback" aria-live="polite">
          {error ? (
            <div className="benchmark-alert benchmark-alert-error" role="alert">
              <CircleAlert aria-hidden="true" />
              <span>{error}</span>
              <button type="button" onClick={() => setError("")}>Dismiss</button>
            </div>
          ) : null}
          {notice ? (
            <div className="benchmark-alert benchmark-alert-success">
              <CheckCircle2 aria-hidden="true" />
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice("")}>Dismiss</button>
            </div>
          ) : null}
        </div>

        <section className="benchmark-library" aria-labelledby="benchmark-library-title">
          <div className="benchmark-section-heading">
            <div>
              <p className="benchmark-section-label">Run history</p>
              <h2 id="benchmark-library-title">Pull requests</h2>
            </div>
            {prs.length ? (
              <span className="benchmark-result-count">
                {prs.length} {prs.length === 1 ? "PR" : "PRs"} · {stats.runCount} runs
              </span>
            ) : null}
          </div>

          {loading ? (
            <DashboardLoading />
          ) : prs.length ? (
            <div className="benchmark-pr-list">
              {prs.map((pr) => (
                <PullRequestCard
                  key={pr.slug || `${pr.owner}/${pr.repo}/${pr.number}`}
                  mutation={mutation}
                  now={now}
                  onCancel={cancelAnalysis}
                  onDelete={deleteHistory}
                  onRefresh={() => createRun(pr.url, { refresh: true })}
                  onRerun={rerun}
                  pr={pr}
                />
              ))}
            </div>
          ) : (
            <EmptyDashboard />
          )}
        </section>
      </main>
    </div>
  );
}

function NewAnalysisForm({
  busy,
  model,
  modelProviders,
  models,
  onModelChange,
  onSubmit,
}) {
  const [prUrl, setPrUrl] = useState("");
  const [validation, setValidation] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    const value = prUrl.trim();
    if (!isGitHubPullRequestUrl(value)) {
      setValidation("Enter a GitHub pull request URL, for example github.com/org/repo/pull/123.");
      return;
    }
    setValidation("");
    if (await onSubmit(value)) {
      setPrUrl("");
    }
  };

  return (
    <section className="benchmark-launcher" aria-labelledby="new-analysis-title">
      <div className="benchmark-launcher-icon" aria-hidden="true">
        <Play />
      </div>
      <div className="benchmark-launcher-copy">
        <h2 id="new-analysis-title">Generate a new analysis</h2>
        <p>
          One review run with highest-effort mini-tree analysis.
        </p>
      </div>
      <form className="benchmark-launcher-form" onSubmit={submit}>
        <label className="benchmark-visually-hidden" htmlFor="pull-request-url">
          GitHub pull request URL
        </label>
        <div className="benchmark-url-field">
          <GitPullRequest aria-hidden="true" />
          <Input
            className="benchmark-url-input"
            id="pull-request-url"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://github.com/owner/repository/pull/123"
            value={prUrl}
            aria-describedby={validation ? "pull-request-url-error" : undefined}
            aria-invalid={Boolean(validation)}
            onChange={(event) => {
              setPrUrl(event.target.value);
              if (validation) {
                setValidation("");
              }
            }}
          />
        </div>
        <div className="benchmark-model-field">
          <label htmlFor="analysis-model">Model</label>
          <Select
            disabled={busy || models.length === 0}
            onValueChange={onModelChange}
            value={model}
          >
            <SelectTrigger
              aria-label="Analysis model"
              className="benchmark-model-trigger"
              id="analysis-model"
            >
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent align="end" position="popper">
              {models.map((modelOption) => (
                <SelectItem key={modelOption} value={modelOption}>
                  {formatModelOption(
                    modelOption,
                    modelProviders?.[modelOption],
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          className="benchmark-primary-button"
          type="submit"
          disabled={busy || !model}
        >
          {busy ? <LoaderCircle className="benchmark-spin" /> : <Play />}
          {busy ? "Adding…" : "Generate analysis"}
        </Button>
        {validation ? (
          <p className="benchmark-field-error" id="pull-request-url-error">{validation}</p>
        ) : null}
      </form>
    </section>
  );
}

function OverviewStats({ stats }) {
  return (
    <dl className="benchmark-overview-stats">
      <div>
        <dt>Saved runs</dt>
        <dd>{stats.runCount}</dd>
      </div>
      <div>
        <dt>In progress</dt>
        <dd className={stats.activeCount ? "benchmark-stat-active" : ""}>{stats.activeCount}</dd>
      </div>
      <div>
        <dt>Latest total</dt>
        <dd>{stats.latestTotalMs == null ? "—" : formatDuration(stats.latestTotalMs)}</dd>
      </div>
    </dl>
  );
}

function PullRequestCard({
  mutation,
  now,
  onCancel,
  onDelete,
  onRefresh,
  onRerun,
  pr,
}) {
  const runs = useMemo(() => sortRuns(pr.runs || []), [pr.runs]);
  const runIndexes = useMemo(
    () => new Map(runs.map((run, index) => [run, index])),
    [runs],
  );
  const [open, setOpen] = useState(false);
  const latestRun = runs[0];
  const totalLoc = metricValue(latestRun, pr, ["changedLines", "loc", "linesChanged", "totalLines"]);
  const fileCount = metricValue(latestRun, pr, ["fileCount", "filesChanged", "changedFiles"]);
  const prSlug = pr.slug || `${pr.owner}-${pr.repo}-${pr.number}`;

  const renderRunCard = (run) => {
    const index = runIndexes.get(run) ?? 0;
    const runId = String(run.id || run.runId || `run-${index + 1}`);
    const previousSucceededRun = findPreviousComparableRun(runs, index);

    return (
      <RunCard
        comparison={buildRunComparison(run, previousSucceededRun, now)}
        key={runId}
        mutation={mutation}
        now={now}
        onCancel={() => onCancel({ prSlug, runId })}
        onDelete={() => onDelete({ prSlug, runId })}
        onRerun={() => onRerun({ prSlug, runId })}
        pr={pr}
        prSlug={prSlug}
        run={run}
        runId={runId}
      />
    );
  };

  return (
    <Collapsible className="benchmark-pr-card" open={open} onOpenChange={setOpen}>
      <div className="benchmark-pr-summary">
        <CollapsibleTrigger className="benchmark-pr-trigger">
          <span className="benchmark-pr-icon" aria-hidden="true">
            <GitPullRequest />
          </span>
          <span className="benchmark-pr-identity">
            <span className="benchmark-repository">
              {pr.owner && pr.repo ? `${pr.owner}/${pr.repo}` : pr.repo || "GitHub pull request"}
              <span>#{pr.number}</span>
            </span>
            <span className="benchmark-pr-title">{pr.title || "Untitled pull request"}</span>
          </span>
          <span className="benchmark-pr-facts">
            <span>{runs.length} {runs.length === 1 ? "run" : "runs"}</span>
            {fileCount != null ? <span>{formatNumber(fileCount)} files</span> : null}
            {totalLoc != null ? <span>{formatNumber(totalLoc)} LOC</span> : null}
          </span>
          <ChevronDown className="benchmark-chevron" aria-hidden="true" />
        </CollapsibleTrigger>
        {pr.url ? (
          <div className="benchmark-pr-actions">
            <Button
              className="benchmark-refresh-pr-button"
              variant="outline"
              size="sm"
              disabled={Boolean(mutation)}
              onClick={onRefresh}
              title="Fetch the latest PR head and create a new analysis"
            >
              {mutation === `refresh:${pr.url}`
                ? <LoaderCircle className="benchmark-spin" />
                : <RefreshCw />}
              Refresh from GitHub
            </Button>
            <a
              className="benchmark-github-link"
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open pull request ${pr.number} on GitHub`}
            >
              GitHub
              <ExternalLink aria-hidden="true" />
            </a>
          </div>
        ) : null}
      </div>
      <CollapsibleContent className="benchmark-pr-content">
        <div className="benchmark-run-list">
          {runs.slice(0, 4).map(renderRunCard)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RunCard({
  comparison,
  mutation,
  now,
  onCancel,
  onDelete,
  onRerun,
  pr,
  prSlug,
  run,
  runId,
}) {
  const status = normalizeStatus(run.status);
  const [open, setOpen] = useState(false);
  const stages = useMemo(() => normalizeStages(run), [run]);
  const totalMs = runDuration(run, now);
  const retries = retryCount(run, stages);
  const reasoningEffort = reasoningEffortLabel(run);
  const graphHref = run.graphUrl || run.reviewUrl || `/reviews/${prSlug}/${runId}/`;
  const canOpenGraph = SUCCESS_STATUSES.has(status) || Boolean(run.graphUrl || run.reviewUrl || run.graphReady);
  const rerunMutation = `rerun:${prSlug}:${runId}`;
  const deleteMutation = `delete:run:${prSlug}:${runId}`;
  const cancelMutation = `cancel:run:${prSlug}:${runId}`;

  return (
    <Collapsible className={`benchmark-run benchmark-run-${status}`} open={open} onOpenChange={setOpen}>
      <div className="benchmark-run-summary">
        <CollapsibleTrigger className="benchmark-run-trigger">
          <span className="benchmark-run-time">
            <span className="benchmark-run-index">
              {reasoningEffort
                ? `${formatReasoningEffort(reasoningEffort)} reasoning`
                : run.label || shortRunLabel(runId)}
            </span>
            <time dateTime={runStartedAt(run)}>
              {formatDateTime(runStartedAt(run))}
            </time>
          </span>
          <StatusBadge status={status} />
          <span className="benchmark-current-step">
            {ACTIVE_STATUSES.has(status) ? (
              <>
                <LoaderCircle className="benchmark-spin" aria-hidden="true" />
                {currentStageLabel(run, stages)}
              </>
            ) : (
              <>
                <History aria-hidden="true" />
                {flattenStageObjects(stages).length}{" "}
                {flattenStageObjects(stages).length === 1 ? "stage" : "stages"}
              </>
            )}
          </span>
          <RunComparison comparison={comparison} />
          <span className="benchmark-total-time">
            <span>Total</span>
            <strong>{totalMs == null ? "—" : formatDuration(totalMs)}</strong>
          </span>
          <ChevronDown className="benchmark-chevron" aria-hidden="true" />
        </CollapsibleTrigger>
        <div className="benchmark-run-actions">
          {ACTIVE_STATUSES.has(status) ? (
            <Button
              className="benchmark-cancel-button"
              variant="destructive"
              size="sm"
              disabled={Boolean(mutation)}
              onClick={onCancel}
              aria-label="Cancel analysis run"
              title="Cancel this analysis run"
            >
              {mutation === cancelMutation
                ? <LoaderCircle className="benchmark-spin" />
                : <XCircle />}
              {mutation === cancelMutation
                ? "Cancelling…"
                : "Cancel run"}
            </Button>
          ) : null}
          {!ACTIVE_STATUSES.has(status) ? (
            <Button
              className="benchmark-rerun-button"
              variant="outline"
              size="sm"
              disabled={Boolean(mutation)}
              onClick={onRerun}
              title="Rerun against the saved PR diff and head SHA with the globally selected model"
            >
              {mutation === rerunMutation
                ? <LoaderCircle className="benchmark-spin" />
                : <RotateCcw />}
              Run again
            </Button>
          ) : null}
          {!ACTIVE_STATUSES.has(status) ? (
            <DeleteHistoryButton
              description="This permanently removes the saved timing data and generated graph for this run."
              disabled={Boolean(mutation)}
              label="Delete run"
              mutationActive={mutation === deleteMutation}
              onDelete={onDelete}
              title="Delete analysis run?"
            />
          ) : null}
          {canOpenGraph ? (
            <Button className="benchmark-open-button" size="sm" asChild>
              <a href={graphHref} target="_blank" rel="noreferrer">
                Open graph
                <ArrowUpRight />
              </a>
            </Button>
          ) : (
            <Button className="benchmark-open-button" size="sm" disabled>
              Open graph
              <ArrowUpRight />
            </Button>
          )}
        </div>
      </div>

      <CollapsibleContent className="benchmark-run-content">
        <div className="benchmark-run-grid">
          <section className="benchmark-timings" aria-label={`Timing breakdown for ${runId}`}>
            <div className="benchmark-subheading">
              <div>
                <span>Timing breakdown</span>
                <small>Wall-clock duration by pipeline stage</small>
              </div>
              {retries ? (
                <Badge className="benchmark-retry-badge" variant="outline">
                  <RotateCcw />
                  {retries} {retries === 1 ? "retry" : "retries"}
                </Badge>
              ) : null}
            </div>
            <TimingWaterfall stages={stages} totalMs={totalMs} now={now} runStatus={status} />
          </section>
          <RunMetadata pr={pr} run={run} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DeleteHistoryButton({
  description,
  disabled,
  label,
  mutationActive,
  onDelete,
  title,
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          aria-label={label}
          className="benchmark-delete-button"
          disabled={disabled}
          size="sm"
          title={label}
          variant="outline"
        >
          {mutationActive
            ? <LoaderCircle className="benchmark-spin" />
            : <Trash2 />}
          {mutationActive ? "Deleting…" : label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep history</AlertDialogCancel>
          <AlertDialogAction
            className="benchmark-delete-confirm"
            onClick={onDelete}
            variant="destructive"
          >
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TimingWaterfall({ now, runStatus, stages, totalMs }) {
  if (!stages.length) {
    return (
      <div className="benchmark-timing-empty">
        {ACTIVE_STATUSES.has(runStatus) ? (
          <>
            <LoaderCircle className="benchmark-spin" aria-hidden="true" />
            Waiting for the first timing measurement…
          </>
        ) : (
          <>
            <TimerReset aria-hidden="true" />
            Timing details were not recorded for this run.
          </>
        )}
      </div>
    );
  }

  const timelineStart = earliestStageTimestamp(stages);
  const flatStages = flattenStages(stages, now, 0, 0, timelineStart);
  const measuredTotal = Math.max(
    totalMs || 0,
    ...flatStages.map((entry) => entry.offsetMs + entry.durationMs),
    1,
  );

  return (
    <div className="benchmark-waterfall">
      <div className="benchmark-waterfall-header" aria-hidden="true">
        <span>Stage</span>
        <span>Timeline</span>
        <span>Time</span>
      </div>
      <ol className="benchmark-stage-list">
        {flatStages.map(({ depth, durationMs, offsetMs, stage }, index) => {
          const stageStatus = normalizeStatus(stage.status || inferStageStatus(stage));
          const width = Math.max((durationMs / measuredTotal) * 100, durationMs ? 1.25 : 0);
          const left = Math.min((offsetMs / measuredTotal) * 100, 99);
          return (
            <li
              className={`benchmark-stage benchmark-stage-${stageStatus}`}
              key={`${stage.id || stage.key || stage.name || "stage"}-${index}`}
              style={{ "--benchmark-depth": depth }}
            >
              <div className="benchmark-stage-label">
                <StageStatusIcon status={stageStatus} />
                <span title={stage.label || stage.name || stage.key}>
                  {stage.label || stage.name || stage.key || `Stage ${index + 1}`}
                </span>
                {stage.retryCount || stage.retries?.length ? (
                  <span className="benchmark-inline-retry">
                    ×{stage.retryCount || stage.retries.length}
                  </span>
                ) : null}
              </div>
              <div className="benchmark-stage-track" aria-hidden="true">
                <Progress
                  className="benchmark-stage-progress"
                  value={100}
                  style={{
                    left: `${left}%`,
                    width: `${Math.min(width, 100 - left)}%`,
                  }}
                />
              </div>
              <span className="benchmark-stage-duration">
                {durationMs ? formatDuration(durationMs) : "—"}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function RunComparison({ comparison }) {
  if (!comparison) {
    return (
      <span className="benchmark-comparison benchmark-comparison-empty">
        <span>Baseline</span>
        <strong>—</strong>
      </span>
    );
  }
  const Icon = comparison.kind === "faster" ? TrendingDown : TrendingUp;
  return (
    <span
      className={`benchmark-comparison benchmark-comparison-${comparison.kind}`}
      aria-label={`${comparison.percentLabel} ${comparison.kind} than the previous successful run with the same PR input`}
    >
      <Icon aria-hidden="true" />
      <span>
        <strong>{comparison.percentLabel} {comparison.kind}</strong>
        <small>{comparison.deltaLabel}</small>
      </span>
    </span>
  );
}

function RunMetadata({ pr, run }) {
  const fileCount = metricValue(run, pr, ["fileCount", "filesChanged", "changedFiles"]);
  const changedLines = metricValue(run, pr, ["changedLines", "loc", "linesChanged", "totalLines"]);
  const additions = metricValue(run, pr, ["additions", "linesAdded"]);
  const deletions = metricValue(run, pr, ["deletions", "linesDeleted"]);
  const headSha = run.headSha || run.input?.headSha || pr.headSha;
  const model = modelLabel(run);
  const reasoningEffort = reasoningEffortLabel(run);
  const tokens = tokenCount(run);

  return (
    <aside className="benchmark-run-metadata" aria-label="Run metadata">
      <div className="benchmark-subheading">
        <div>
          <span>Run context</span>
          <small>Saved with this benchmark</small>
        </div>
      </div>
      <dl className="benchmark-metadata-list">
        <MetadataRow icon={FileCode2} label="Change size">
          {fileCount != null ? `${formatNumber(fileCount)} files` : "—"}
          {changedLines != null ? ` · ${formatNumber(changedLines)} LOC` : ""}
          {changedLines == null && additions != null
            ? ` · +${formatNumber(additions)} / −${formatNumber(deletions || 0)}`
            : ""}
        </MetadataRow>
        <MetadataRow icon={GitCommitHorizontal} label="Head SHA" mono>
          {headSha ? String(headSha).slice(0, 10) : "—"}
        </MetadataRow>
        <MetadataRow icon={Activity} label="Model">
          {model || "—"}
        </MetadataRow>
        <MetadataRow icon={Gauge} label="Reasoning">
          {reasoningEffort ? formatReasoningEffort(reasoningEffort) : "—"}
        </MetadataRow>
        <MetadataRow icon={Clock3} label="Tokens">
          {tokens == null ? "—" : formatNumber(tokens)}
        </MetadataRow>
      </dl>
    </aside>
  );
}

function MetadataRow({ children, icon: Icon, label, mono = false }) {
  return (
    <div>
      <dt>
        <Icon aria-hidden="true" />
        {label}
      </dt>
      <dd className={mono ? "benchmark-mono" : ""}>{children}</dd>
    </div>
  );
}

function StatusBadge({ status }) {
  const details = statusDetails(status);
  const Icon = details.icon;
  return (
    <Badge className={`benchmark-status benchmark-status-${status}`} variant="outline">
      <Icon className={ACTIVE_STATUSES.has(status) ? "benchmark-spin" : ""} aria-hidden="true" />
      {details.label}
    </Badge>
  );
}

function StageStatusIcon({ status }) {
  if (ACTIVE_STATUSES.has(status)) {
    return <LoaderCircle className="benchmark-spin" aria-hidden="true" />;
  }
  if (SUCCESS_STATUSES.has(status)) {
    return <CheckCircle2 aria-hidden="true" />;
  }
  if (FAILURE_STATUSES.has(status)) {
    return <XCircle aria-hidden="true" />;
  }
  return <Clock3 aria-hidden="true" />;
}

function DashboardLoading() {
  return (
    <div className="benchmark-loading" role="status">
      <LoaderCircle className="benchmark-spin" aria-hidden="true" />
      Loading saved benchmarks…
    </div>
  );
}

function EmptyDashboard() {
  return (
    <div className="benchmark-empty">
      <span className="benchmark-empty-icon" aria-hidden="true">
        <TimerReset />
      </span>
      <h3>No benchmark runs yet</h3>
      <p>Paste a GitHub pull request above to create the first timed analysis.</p>
    </div>
  );
}

function sortPullRequests(prs) {
  return [...prs].sort((left, right) => latestRunTimestamp(right) - latestRunTimestamp(left));
}

function sortRuns(runs) {
  return [...runs].sort((left, right) => runTimestamp(right) - runTimestamp(left));
}

function latestRunTimestamp(pr) {
  return Math.max(...(pr.runs || []).map(runTimestamp), parseTimestamp(pr.updatedAt), 0);
}

function runTimestamp(run) {
  return parseTimestamp(
    runStartedAt(run)
    || runTimestampValue(run, "createdAt")
    || runTimestampValue(run, "updatedAt")
    || runCompletedAt(run),
  );
}

function dashboardStats(prs, now) {
  const runs = prs.flatMap((pr) => pr.runs || []);
  const latest = sortRuns(runs)[0];
  return {
    activeCount: runs.filter((run) => ACTIVE_STATUSES.has(normalizeStatus(run.status))).length,
    latestTotalMs: latest ? runDuration(latest, now) : null,
    runCount: runs.length,
  };
}

function normalizeStages(run) {
  const candidates = [
    run.timings?.steps,
    run.timings?.stages,
    run.timing?.steps,
    run.timing?.stages,
    run.steps,
    run.stages,
  ];
  const stages = candidates.find(Array.isArray) || [];
  if (!stages.some((stage) => stage.parentStageId)) {
    return stages;
  }

  const copies = stages.map((stage, index) => ({
    ...stage,
    __dashboardKey: `${stage.stageId || stage.id || index}:${stage.attempt || 1}:${index}`,
    substeps: [],
  }));
  const firstByStageId = new Map();
  for (const stage of copies) {
    const stageId = stage.stageId || stage.id;
    if (stageId && !firstByStageId.has(stageId)) {
      firstByStageId.set(stageId, stage);
    }
  }
  const roots = [];
  for (const stage of copies) {
    const parent = stage.parentStageId ? firstByStageId.get(stage.parentStageId) : null;
    if (parent && parent !== stage) {
      parent.substeps.push(stage);
    } else {
      roots.push(stage);
    }
  }
  return roots;
}

function flattenStages(stages, now, depth = 0, inheritedOffset = 0, timelineStart = 0) {
  const flattened = [];
  let cursor = inheritedOffset;
  for (const stage of stages) {
    const timestampOffset = timelineStart && parseTimestamp(stage.startedAt)
      ? Math.max(0, parseTimestamp(stage.startedAt) - timelineStart)
      : null;
    const explicitOffset = numericValue(stage.offsetMs, stage.startOffsetMs, timestampOffset);
    const offsetMs = explicitOffset == null ? cursor : explicitOffset;
    const durationMs = stageDuration(stage, now);
    flattened.push({ depth, durationMs, offsetMs, stage });
    const children = stage.substeps || stage.steps || stage.children || [];
    if (Array.isArray(children) && children.length) {
      flattened.push(...flattenStages(children, now, depth + 1, offsetMs, timelineStart));
    }
    cursor = Math.max(cursor, offsetMs + durationMs);
  }
  return flattened;
}

function stageDuration(stage, now) {
  const explicit = numericValue(stage.durationMs, stage.elapsedMs, stage.wallTimeMs, stage.wallMs);
  const startedAt = parseTimestamp(stage.startedAt);
  if (ACTIVE_STATUSES.has(normalizeStatus(stage.status)) && startedAt) {
    return Math.max(explicit || 0, now - startedAt);
  }
  if (explicit != null) {
    return explicit;
  }
  if (!startedAt) {
    return 0;
  }
  const finishedAt = parseTimestamp(stage.finishedAt || stage.endedAt || stage.completedAt);
  return Math.max(0, (finishedAt || now) - startedAt);
}

function runDuration(run, now) {
  const explicit = numericValue(
    run.totalMs,
    run.durationMs,
    run.elapsedMs,
    run.wallTimeMs,
    run.timings?.totalMs,
    run.timings?.totalDurationMs,
    run.timing?.totalMs,
    run.metrics?.totalMs,
  );
  if (explicit != null && !ACTIVE_STATUSES.has(normalizeStatus(run.status))) {
    return explicit;
  }
  const startedAt = parseTimestamp(runStartedAt(run));
  if (!startedAt) {
    return explicit;
  }
  const finishedAt = parseTimestamp(runCompletedAt(run));
  return Math.max(explicit || 0, (finishedAt || now) - startedAt);
}

function retryCount(run, stages) {
  const explicit = numericValue(run.retryCount, run.retries?.length, run.metrics?.retries);
  if (explicit != null) {
    return explicit;
  }
  const flatStages = flattenStageObjects(stages);
  const analysisAttempts = flatStages
    .filter((stage) => /^analysis(?:\.attempt-\d+)?$/i.test(stage.stageId || stage.id || ""))
    .map((stage) => {
      const idAttempt = String(stage.stageId || stage.id || "").match(/\.attempt-(\d+)$/i)?.[1];
      return numericValue(stage.attempt, idAttempt) || 1;
    });
  const retriesFromAttempts = analysisAttempts.length
    ? Math.max(0, Math.max(...analysisAttempts) - 1)
    : 0;
  const retryingFailures = flatStages.filter((stage) => stage.metrics?.willRetry === true).length;
  const annotatedRetries = stages.reduce((total, stage) => {
    return total
      + (numericValue(stage.retryCount, stage.retries?.length) || 0)
      + retryCount({}, stage.substeps || stage.steps || []);
  }, 0);
  return Math.max(retriesFromAttempts, retryingFailures, annotatedRetries);
}

function metricValue(run, pr, keys) {
  for (const source of [run, run.metrics, run.input, run.pr, pr, pr.metrics]) {
    for (const key of keys) {
      const value = source?.[key];
      if (Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
  }
  return null;
}

function tokenCount(run) {
  const tokenSources = [run.tokens, run.usage, run.metrics?.tokens, run.metrics?.usage];
  for (const tokens of tokenSources) {
    if (Number.isFinite(Number(tokens))) {
      return Number(tokens);
    }
    if (tokens && typeof tokens === "object") {
      const total = numericValue(tokens.total, tokens.totalTokens, tokens.total_tokens);
      if (total != null) {
        return total;
      }
      const input = numericValue(tokens.input, tokens.inputTokens, tokens.input_tokens) || 0;
      const output = numericValue(tokens.output, tokens.outputTokens, tokens.output_tokens) || 0;
      if (input || output) {
        return input + output;
      }
    }
  }
  return null;
}

function modelLabel(run) {
  const model = run.model || run.configuration?.model || run.metrics?.model;
  if (typeof model === "string") {
    return model;
  }
  if (model?.name) {
    return model.name;
  }
  if (Array.isArray(run.models)) {
    return run.models.map((item) => typeof item === "string" ? item : item.name).filter(Boolean).join(", ");
  }
  return "";
}

function reasoningEffortLabel(run) {
  const effort = run.reasoningEffort
    || run.configuration?.reasoningEffort
    || run.metrics?.reasoningEffort;
  return typeof effort === "string" ? effort : "";
}

function currentStageLabel(run, stages) {
  const explicit = run.currentStage?.label
    || run.currentStage?.name
    || run.currentStage
    || run.progress?.currentStage;
  if (explicit) {
    return explicit;
  }
  const active = flattenStages(stages, Date.now())
    .map((entry) => entry.stage)
    .find((stage) => ACTIVE_STATUSES.has(normalizeStatus(stage.status)));
  return active?.label || active?.name || active?.key || (normalizeStatus(run.status) === "queued"
    ? "Waiting in queue"
    : "Analysis in progress");
}

function inferStageStatus(stage) {
  if (stage.finishedAt || stage.endedAt || stage.completedAt || numericValue(stage.durationMs) != null) {
    return "completed";
  }
  if (stage.startedAt) {
    return "running";
  }
  return "queued";
}

function earliestStageTimestamp(stages) {
  const timestamps = flattenStageObjects(stages)
    .map((stage) => parseTimestamp(stage.startedAt))
    .filter(Boolean);
  return timestamps.length ? Math.min(...timestamps) : 0;
}

function flattenStageObjects(stages) {
  return stages.flatMap((stage) => [
    stage,
    ...flattenStageObjects(stage.substeps || stage.steps || stage.children || []),
  ]);
}

function buildRunComparison(run, baseline, now) {
  const inputFingerprint = runInputFingerprint(run);
  if (
    !baseline
    || !inputFingerprint
    || inputFingerprint !== runInputFingerprint(baseline)
    || !SUCCESS_STATUSES.has(normalizeStatus(run.status))
    || !SUCCESS_STATUSES.has(normalizeStatus(baseline.status))
  ) {
    return null;
  }
  const currentMs = runDuration(run, now);
  const baselineMs = runDuration(baseline, now);
  if (currentMs == null || !baselineMs) {
    return null;
  }
  const deltaMs = currentMs - baselineMs;
  if (Math.abs(deltaMs) < 1) {
    return {
      deltaLabel: "No change",
      kind: "faster",
      percentLabel: "0%",
    };
  }
  return {
    deltaLabel: `${deltaMs < 0 ? "−" : "+"}${formatDuration(Math.abs(deltaMs))}`,
    kind: deltaMs < 0 ? "faster" : "slower",
    percentLabel: `${Math.abs((deltaMs / baselineMs) * 100).toFixed(1)}%`,
  };
}

function findPreviousComparableRun(runs, index) {
  const run = runs[index];
  const inputFingerprint = runInputFingerprint(run);
  if (!inputFingerprint) {
    return null;
  }

  return runs
    .slice(index + 1)
    .find((candidate) => (
      SUCCESS_STATUSES.has(normalizeStatus(candidate.status))
      && runInputFingerprint(candidate) === inputFingerprint
      && modelLabel(candidate) === modelLabel(run)
      && reasoningEffortLabel(candidate) === reasoningEffortLabel(run)
    ));
}

function runInputFingerprint(run) {
  for (const candidate of [
    run?.inputFingerprint,
    run?.input?.fingerprint,
    run?.input?.inputFingerprint,
    run?.metrics?.inputFingerprint,
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function statusDetails(status) {
  if (SUCCESS_STATUSES.has(status)) {
    return { icon: CheckCircle2, label: "Complete" };
  }
  if (status === "running") {
    return { icon: LoaderCircle, label: "Running" };
  }
  if (status === "queued") {
    return { icon: Clock3, label: "Queued" };
  }
  if (FAILURE_STATUSES.has(status)) {
    return {
      icon: XCircle,
      label: status === "interrupted" ? "Interrupted" : status === "cancelled" || status === "canceled"
        ? "Cancelled"
        : "Failed",
    };
  }
  return { icon: Clock3, label: status ? titleCase(status) : "Unknown" };
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function numericValue(...values) {
  for (const value of values) {
    if (value !== "" && value != null && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function parseTimestamp(value) {
  if (!value) {
    return 0;
  }
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function runTimestampValue(run, key) {
  return run?.[key] || run?.timestamps?.[key] || "";
}

function runStartedAt(run) {
  return runTimestampValue(run, "startedAt")
    || runTimestampValue(run, "queuedAt")
    || runTimestampValue(run, "createdAt");
}

function runCompletedAt(run) {
  return runTimestampValue(run, "finishedAt")
    || runTimestampValue(run, "completedAt");
}

function formatDateTime(value) {
  const timestamp = parseTimestamp(value);
  if (!timestamp) {
    return "Time unavailable";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function formatDuration(milliseconds) {
  const ms = Math.max(0, Number(milliseconds) || 0);
  if (ms < 1_000) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (minutes < 60) {
    return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatNumber(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function shortRunLabel(runId) {
  const readable = String(runId).replace(/^run[-_]?/i, "");
  if (/^\d{4}-\d{2}-\d{2}T/.test(readable)) {
    return "Run";
  }
  return `Run ${readable.length > 10 ? readable.slice(-8) : readable}`;
}

function titleCase(value) {
  return value.replace(/(^|[-_\s])(\w)/g, (_, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function formatReasoningEffort(value) {
  return value === "xhigh" ? "X-high" : titleCase(value);
}

function formatModelOption(model, provider) {
  if (provider === "claude") {
    const match = model.match(
      /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(\[1m\])?$/i,
    );
    if (match) {
      const [, family, major, minor, extendedContext] = match;
      return `Claude ${titleCase(family)} ${major}.${minor}`
        + `${extendedContext ? " · 1M" : ""}`;
    }
    return `Claude · ${model}`;
  }
  if (provider === "codex") {
    return `OpenAI · ${model}`;
  }
  return model;
}

function isGitHubPullRequestUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:")
      && url.hostname.toLowerCase() === "github.com"
      && /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export function mountDashboardApp(target = document.getElementById("pr-dashboard-root"), options = {}) {
  if (!target) {
    throw new Error("Dashboard mount target was not found.");
  }
  if (target.dataset.dashboardMounted === "true") {
    return null;
  }
  target.dataset.dashboardMounted = "true";
  const root = createRoot(target);
  root.render(<DashboardApp {...options} />);
  return root;
}

if (typeof document !== "undefined") {
  const dashboardRoot = document.getElementById("pr-dashboard-root");
  if (dashboardRoot) {
    mountDashboardApp(dashboardRoot);
  }
}
