export function normalizeAnalysisCandidate(value) {
  const url = new URL(value?.url);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !match) {
    throw new Error("A valid GitHub pull request URL is required.");
  }
  return {
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    title: typeof value.title === "string" ? value.title.slice(0, 500) : "",
    additions: Number.isInteger(value.additions) ? value.additions : null,
    deletions: Number.isInteger(value.deletions) ? value.deletions : null,
    changedFiles: Number.isInteger(value.changedFiles) ? value.changedFiles : null,
    headSha: typeof value.headSha === "string" ? value.headSha : "",
  };
}

function changedLineCount(value) {
  return Number.isInteger(value.additions) && Number.isInteger(value.deletions)
    ? value.additions + value.deletions
    : Number.MAX_SAFE_INTEGER;
}

export function sortPullRequestsBySize(values) {
  return [...values].sort(
    (left, right) =>
      changedLineCount(left) - changedLineCount(right) ||
      (left.changedFiles ?? Number.MAX_SAFE_INTEGER) -
        (right.changedFiles ?? Number.MAX_SAFE_INTEGER) ||
      left.url.localeCompare(right.url),
  );
}

function alreadyAnalyzed(dashboard, candidate) {
  const pullRequest = (dashboard.prs ?? dashboard.pullRequests ?? []).find(
    (item) => item.url === candidate.url,
  );
  return pullRequest?.runs?.some(
    (run) =>
      ["queued", "running"].includes(run.status) ||
      (run.status === "succeeded" && (!candidate.headSha || run.headSha === candidate.headSha)),
  );
}

export async function enqueueMissingAnalyses(values, dashboardService) {
  const candidates = sortPullRequestsBySize(values.slice(0, 100).map(normalizeAnalysisCandidate));
  const dashboard = await dashboardService.snapshot();
  const runs = [];
  for (const candidate of candidates) {
    if (alreadyAnalyzed(dashboard, candidate)) continue;
    runs.push(
      await dashboardService.enqueue({
        prUrl: candidate.url,
        refresh: true,
        title: candidate.title,
      }),
    );
  }
  return runs;
}
