export const EMPTY_SETTINGS = { username: "", people: [], teams: [] };

export const ACTIVITY_SIGNAL_KINDS = new Set([
  "direct-review",
  "post-merge-comment",
  "review-reply",
  "direct-mention",
  "my-pr-activity",
  "new-commits",
  "team-review",
  "new-comments",
  "team-mention",
]);

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
  return item.lifecycle === filter;
}

export function myPullRequestStatus(item) {
  if (item.state === "MERGED") return "merged";
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
  return {
    active,
    href: succeeded ? `/reviews/${encodeURIComponent(pullRequest.slug)}/` : "",
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
