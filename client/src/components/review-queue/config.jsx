import {
  Archive,
  Bell,
  CheckCircle2,
  Eye,
  FileClock,
  GitMerge,
  GitPullRequest,
} from "lucide-react";

export const LIFECYCLE_ORDER = [
  "reviewed",
  "new",
  "approved",
  "merged",
  "draft",
  "mine",
  "other",
];

export const LIFECYCLE_META = {
  reviewed: { label: "Reviewed", score: 10, icon: Eye },
  new: { label: "Unreviewed", score: 0, icon: GitPullRequest },
  approved: { label: "Approved", score: -5, icon: CheckCircle2 },
  merged: { label: "Merged", score: -5, icon: GitMerge },
  draft: { label: "Draft", score: -10, icon: FileClock },
  mine: { label: "My pull requests", score: 0, icon: GitPullRequest },
  other: { label: "Other PR notifications", score: 0, icon: Archive },
  nonpr: { label: "Issues & other notifications", score: null, icon: Bell },
};

export const FILTER_GROUPS = [
  {
    label: "Lifecycle",
    filters: LIFECYCLE_ORDER.filter((id) => !["mine", "other", "draft"].includes(id)).map((id) => ({
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
  reviewed: "border-coral/25 bg-coral/10 text-coral-strong",
  new: "border-sky/25 bg-sky/10 text-sky-strong",
  approved: "border-lilac/25 bg-lilac/10 text-lilac-strong",
  merged: "border-lilac/25 bg-lilac/10 text-lilac-strong",
  draft: "border-border bg-muted text-muted-foreground",
  mine: "border-ochre/25 bg-ochre/10 text-ochre-strong",
  other: "border-border bg-secondary/70 text-muted-foreground",
};
