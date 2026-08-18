import { LIFECYCLE_SCORES, SIGNAL_LABELS, SIGNAL_WEIGHTS } from "../../../shared/queue-policy.js";

export const SCORING_LIFECYCLE_BARS = Object.freeze([
  { id: "reviewed", label: "Reviewed", score: LIFECYCLE_SCORES.reviewed },
  { id: "new", label: "Unreviewed", score: LIFECYCLE_SCORES.new },
  { id: "mine", label: "My pull request", score: LIFECYCLE_SCORES.mine },
  { id: "approved", label: "Approved", score: LIFECYCLE_SCORES.approved },
  { id: "merged", label: "Merged", score: LIFECYCLE_SCORES.merged },
  { id: "closed", label: "Closed", score: LIFECYCLE_SCORES.closed },
  { id: "draft", label: "Draft", score: LIFECYCLE_SCORES.draft },
]);

export const SCORING_SIGNAL_BARS = Object.freeze(
  Object.entries(SIGNAL_WEIGHTS)
    .map(([id, score]) => ({ id, label: SIGNAL_LABELS[id], score }))
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label)),
);

export function scoreBarLayout(score, maxAbs) {
  const span = Math.max(Math.abs(maxAbs), 1);
  const widthPercent = (Math.abs(score) / span) * 50;
  return {
    negative: score < 0,
    offsetPercent: score >= 0 ? 50 : 50 - widthPercent,
    widthPercent,
  };
}
