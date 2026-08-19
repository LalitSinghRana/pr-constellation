import {
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_PROVIDER,
  DEFAULT_ANALYSIS_REASONING_EFFORT,
} from "../../../shared/analysis-models.js";
import { ACTIVITY_SIGNAL_KINDS as ACTIVITY_SIGNAL_KIND_VALUES } from "../../../shared/queue-policy.js";

export const EMPTY_SETTINGS = {
  username: "",
  people: [],
  teams: [],
  autoQueue: false,
  showMinimap: false,
  defaultAnalysisProvider: DEFAULT_ANALYSIS_PROVIDER,
  defaultAnalysisModel: DEFAULT_ANALYSIS_MODEL,
  defaultAnalysisReasoningEffort: DEFAULT_ANALYSIS_REASONING_EFFORT,
};

export const ACTIVITY_SIGNAL_KINDS = new Set(ACTIVITY_SIGNAL_KIND_VALUES);

export const NOTIFICATION_LABELS = {
  assign: "Assigned to you",
  author: "Activity on your PR",
  ci_activity: "CI activity",
  comment: "New comment",
  invitation: "Repository invitation",
  manual: "Subscribed",
  mention: "Mentioned you",
  review_requested: "Review requested",
  security_alert: "Security alert",
  state_change: "State changed",
  subscribed: "Subscribed update",
  team_mention: "Team mentioned",
};

export function matchesPrFilter(item, filter) {
  if (filter === "done") return true;
  if (filter === "mine") return item.authored;
  if (item.authored) return false;
  return item.lifecycle === filter;
}

export function inboxProjectTabs(items, filter, isDone = (item) => Boolean(item.done)) {
  const completed = filter === "done";
  const matching = new Map();
  for (const item of items) {
    if (isDone(item) !== completed) continue;
    if (!matchesPrFilter(item, filter)) continue;
    matching.set(item.repository, (matching.get(item.repository) ?? 0) + 1);
  }
  return [...matching.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((repository) => ({
      repository,
      count: matching.get(repository),
    }));
}

export function myPullRequestStatus(item) {
  if (item.state === "MERGED") return "merged";
  if (item.state === "CLOSED") return "closed";
  if (item.reviewDecision === "APPROVED") return "approved";
  return item.draft ? "draft" : "opened";
}

export function safeGitHubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.href : "#";
  } catch {
    return "#";
  }
}

export function analysisFor(item, pullRequest) {
  const runs = pullRequest?.runs ?? [];
  const active = runs.find((run) => ["queued", "running"].includes(run.status));
  const succeeded = runs.find(
    (run) => run.status === "succeeded" && (!item.headSha || run.headSha === item.headSha),
  );
  const pastSuccess = runs.some((run) => run.status === "succeeded");
  return {
    active,
    bumped: Boolean(active?.metrics?.bumpedAt),
    href: succeeded ? `/reviews/${encodeURIComponent(pullRequest.slug)}/` : "",
    pastSuccess,
    runId: active?.runId || null,
    slug: pullRequest?.slug || active?.slug || "",
    url: pullRequest?.url || item.url,
  };
}

export function signedScore(value) {
  return value > 0 ? `+${value}` : String(value);
}

export function relativeTime(date) {
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  const ranges = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of ranges) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function parseList(value) {
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

const updatedDateFormatter = new Intl.DateTimeFormat("en", {
  weekday: "long",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function groupByUpdatedDate(items, { preserveOrder = false } = {}) {
  const groups = new Map();
  for (const item of items) {
    const date = new Date(item.updatedAt);
    const key = date.toDateString();
    const group = groups.get(key) ?? {
      label: Number.isNaN(date.getTime()) ? "Unknown date" : updatedDateFormatter.format(date),
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  if (!preserveOrder) {
    for (const group of groups.values()) {
      group.items.sort(
        (left, right) =>
          (right.score ?? 0) - (left.score ?? 0) ||
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      );
    }
  }
  return [...groups.values()];
}
