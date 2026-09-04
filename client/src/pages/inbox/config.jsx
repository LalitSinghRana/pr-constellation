import {
  Archive,
  Bell,
  CheckCircle2,
  Eye,
  FileClock,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
} from "lucide-react";
import { LIFECYCLE_SCORES } from "../../../../shared/queue-policy.js";

export const LIFECYCLE_ORDER = [
  "reviewed",
  "new",
  "approved",
  "merged",
  "closed",
  "draft",
  "mine",
  "other",
];

export const LIFECYCLE_META = {
  reviewed: { label: "Reviewed", score: LIFECYCLE_SCORES.reviewed, icon: Eye },
  new: { label: "Unreviewed", score: LIFECYCLE_SCORES.new, icon: GitPullRequest },
  approved: { label: "Approved", score: LIFECYCLE_SCORES.approved, icon: CheckCircle2 },
  merged: { label: "Merged", score: LIFECYCLE_SCORES.merged, icon: GitMerge },
  closed: { label: "Closed", score: LIFECYCLE_SCORES.closed, icon: GitPullRequestClosed },
  draft: { label: "Draft", score: LIFECYCLE_SCORES.draft, icon: FileClock },
  mine: { label: "My pull requests", score: LIFECYCLE_SCORES.mine, icon: GitPullRequest },
  other: { label: "Other PR notifications", score: LIFECYCLE_SCORES.other, icon: Archive },
  nonpr: { label: "Issues & other notifications", score: null, icon: Bell },
};

export const FILTER_GROUPS = [
  {
    label: "Lifecycle",
    filters: LIFECYCLE_ORDER.filter((id) => !["mine", "other"].includes(id)).map((id) => ({
      id,
      label: LIFECYCLE_META[id].label,
      icon: LIFECYCLE_META[id].icon,
    })),
  },
  {
    label: "My work",
    filters: [{ id: "mine", label: "My pull requests", icon: GitPullRequest }],
  },
  {
    label: "Other",
    filters: [
      { id: "other", label: "Other PR notifications", icon: Archive },
      { id: "nonpr", label: "Issues & other notifications", icon: Bell },
    ],
  },
];

export const LIFECYCLE_STYLES = {
  reviewed: "border-error/25 bg-error/10 text-error-strong",
  new: "border-info/25 bg-info/10 text-info-strong",
  approved: "border-lilac/25 bg-lilac/10 text-lilac-strong",
  merged: "border-lilac/25 bg-lilac/10 text-lilac-strong",
  closed: "border-border bg-muted text-muted-foreground",
  draft: "border-border bg-muted text-muted-foreground",
  mine: "border-warning/25 bg-warning/10 text-warning-strong",
  other: "border-border bg-secondary/70 text-muted-foreground",
};
