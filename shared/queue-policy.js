export const ACTIVITY_SIGNAL_KINDS = Object.freeze([
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

export const LIFECYCLE_SCORES = Object.freeze({
  reviewed: 10,
  new: 0,
  approved: -5,
  merged: -5,
  draft: -10,
  mine: 0,
  other: 0,
});

const attentionExcludingTeamCovered = (signals) =>
  signals.some((signal) => signal.kind !== "team-covered");

export function lifecycleForQueueItem(item) {
  if (item.state === "MERGED") {
    return "merged";
  }
  if (item.draft) {
    return "draft";
  }
  if (item.authored) {
    return "mine";
  }
  if (item.latestReviewState === "APPROVED") {
    return "approved";
  }
  if (item.latestReviewState || item.reviewed) {
    return "reviewed";
  }
  if (item.state === "OPEN" || attentionExcludingTeamCovered(item.signals)) {
    return "new";
  }
  return "other";
}
