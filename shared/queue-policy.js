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
  closed: -5,
  draft: -10,
  mine: 0,
  other: 0,
});

export const SIGNAL_WEIGHTS = Object.freeze({
  "direct-review": 10,
  "post-merge-comment": 10,
  "teammate-pr": 7,
  "review-reply": 6,
  "direct-mention": 6,
  "my-pr-activity": 5,
  "new-commits": 3,
  "team-review": 3,
  "new-comments": 2,
  "team-mention": 2,
  "team-covered": -4,
});

export const SIGNAL_LABELS = Object.freeze({
  "direct-review": "Direct review request",
  "post-merge-comment": "Comment after merge",
  "teammate-pr": "Teammate PR",
  "review-reply": "Reply to your review",
  "direct-mention": "Mentioned you",
  "my-pr-activity": "Activity on your PR",
  "new-commits": "New commits",
  "team-review": "Team review request",
  "new-comments": "New comments",
  "team-mention": "Team mentioned",
  "team-covered": "Covered by teammate",
});

export function lifecycleForQueueItem(item) {
  if (item.state === "MERGED") return "merged";
  if (item.state === "CLOSED") return "closed";
  if (item.draft) return "draft";
  if (item.authored) return "mine";
  if (item.latestReviewState === "APPROVED") return "approved";
  if (item.latestReviewState || item.reviewed) return "reviewed";
  if (
    item.state === "OPEN" ||
    item.state === "UNKNOWN" ||
    item.signals.some((signal) => signal.kind !== "team-covered")
  ) {
    return "new";
  }
  return "other";
}

export function isOpenAuthoredPullRequest(item) {
  return Boolean(item?.authored) && item.state !== "MERGED" && item.state !== "CLOSED";
}
