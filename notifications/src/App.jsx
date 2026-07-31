import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowUpRight,
  AtSign,
  Bell,
  Check,
  CheckCircle2,
  Eye,
  FileClock,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  ListPlus,
  LoaderCircle,
  MessageSquare,
  MessageSquareReply,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { analysisState, cn } from "./lib/utils";

const emptySettings = { username: "", people: [], teams: [] };
const lifecycleOrder = ["reviewed", "new", "approved", "merged", "draft", "mine", "other"];

const lifecycleMeta = {
  reviewed: { label: "Reviewed", score: 10, icon: Eye },
  new: { label: "New / unreviewed", score: 0, icon: GitPullRequest },
  approved: { label: "Approved", score: -5, icon: CheckCircle2 },
  merged: { label: "Merged", score: -5, icon: GitMerge },
  draft: { label: "Draft", score: -10, icon: FileClock },
  mine: { label: "My pull requests", score: 0, icon: GitPullRequest },
  other: { label: "Other notification PRs", score: 0, icon: Archive },
  nonpr: { label: "Non-PR", score: null, icon: Bell },
};

const filterGroups = [
  {
    label: "Lifecycle",
    filters: lifecycleOrder
      .filter((id) => !["mine", "other"].includes(id))
      .map((id) => ({
        id,
        label: lifecycleMeta[id].label,
        icon: lifecycleMeta[id].icon,
      })),
  },
  {
    label: "My work",
    filters: [{ id: "mine", label: "My pull requests", icon: GitPullRequest }],
  },
  {
    label: "Other",
    filters: [
      { id: "other", label: "Other notification PRs", icon: Archive },
      { id: "nonpr", label: "Non-PR", icon: Bell },
      { id: "done", label: "Done", icon: Check },
    ],
  },
];

const scoreLegend = [
  {
    label: "Lifecycle",
    items: [
      { label: "Reviewed", score: 10, color: "bg-coral" },
      { label: "Approved", score: -5, color: "bg-sky" },
      { label: "Merged", score: -5, color: "bg-lilac" },
      { label: "Draft", score: -10, color: "bg-muted-foreground" },
    ],
  },
  {
    label: "Fresh signals",
    items: [
      { label: "Direct request", score: 10, color: "bg-coral" },
      { label: "Post-merge comment", score: 10, color: "bg-coral" },
      { label: "Teammate PR", score: 7, color: "bg-ochre" },
      { label: "Review reply", score: 6, color: "bg-sky" },
      { label: "Changes / team", score: 3, color: "bg-lilac" },
    ],
  },
];

const signalStyles = {
  "direct-review": "border-coral/20 bg-coral/10 text-coral-strong",
  "post-merge-comment": "border-coral/20 bg-coral/10 text-coral-strong",
  "teammate-pr": "border-ochre/25 bg-ochre/10 text-ochre-strong",
  "review-reply": "border-coral/20 bg-coral/10 text-coral-strong",
  "direct-mention": "border-sky/20 bg-sky/10 text-sky-strong",
  "my-pr-activity": "border-ochre/25 bg-ochre/10 text-ochre-strong",
  "new-commits": "border-sky/20 bg-sky/10 text-sky-strong",
  "team-review": "border-lilac/25 bg-lilac/10 text-lilac-strong",
  "new-comments": "border-border bg-secondary/70 text-secondary-foreground",
  "team-mention": "border-lilac/25 bg-lilac/10 text-lilac-strong",
  "team-covered": "border-border bg-muted text-muted-foreground",
};

const activitySignalKinds = new Set([
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

const lifecycleStyles = {
  reviewed: "border-coral/25 bg-coral/10 text-coral-strong",
  new: "border-sky/25 bg-sky/10 text-sky-strong",
  approved: "border-lilac/25 bg-lilac/10 text-lilac-strong",
  merged: "border-lilac/25 bg-lilac/10 text-lilac-strong",
  draft: "border-border bg-muted text-muted-foreground",
  mine: "border-ochre/25 bg-ochre/10 text-ochre-strong",
  other: "border-border bg-secondary/70 text-muted-foreground",
};

const notificationLabels = {
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

const scoringSignalRows = [
  ["Direct review request", 10, "GitHub currently requests you as a reviewer."],
  ["Comment after merge", 10, "Someone comments after the PR was merged."],
  ["Teammate authored PR", 7, "The author is in your configured teammate list."],
  ["Reply to your review", 6, "Someone replies after your review comment."],
  ["New commits", 3, "Commits landed after your latest review."],
  ["Team review request", 3, "A configured GitHub team is requested."],
  ["New comments", 2, "General comments arrived after your latest review."],
  ["Covered by teammate", -4, "Your team was requested, but a teammate already reviewed."],
];

const scoringSignalScores = new Map(
  scoringSignalRows.map(([label, score]) => [label, score]),
);

const scoringScenarioGroups = [
  {
    lifecycle: "Reviewed",
    base: 10,
    description: "You commented or requested changes in your latest review.",
    scenarios: [
      [
        "Re-requested teammate PR with reply, commits, and team request",
        [
          "Direct review request",
          "Teammate authored PR",
          "Reply to your review",
          "New commits",
          "Team review request",
        ],
      ],
      [
        "Teammate PR with a reply and new commits",
        ["Teammate authored PR", "Reply to your review", "New commits"],
      ],
      ["Reply and new commits", ["Reply to your review", "New commits"]],
      ["No fresh activity", []],
    ],
  },
  {
    lifecycle: "New / unreviewed",
    base: 0,
    description: "A priority signal exists, but you have not reviewed the PR.",
    scenarios: [
      [
        "Teammate PR requesting you and your team",
        [
          "Direct review request",
          "Teammate authored PR",
          "Team review request",
        ],
      ],
      [
        "New teammate PR requesting you",
        ["Direct review request", "Teammate authored PR"],
      ],
      ["Direct review request", ["Direct review request"]],
      [
        "Team request already covered by a teammate",
        ["Team review request", "Covered by teammate"],
      ],
    ],
  },
  {
    lifecycle: "My pull request",
    base: 0,
    description: "You authored the open PR.",
    scenarios: [["Open pull request", []]],
  },
  {
    lifecycle: "Approved",
    base: -5,
    description: "Your latest review approved the PR.",
    scenarios: [
      [
        "Re-requested teammate PR with reply, commits, and team request",
        [
          "Direct review request",
          "Teammate authored PR",
          "Reply to your review",
          "New commits",
          "Team review request",
        ],
      ],
      [
        "Directly re-requested with a reply",
        ["Direct review request", "Reply to your review"],
      ],
      ["Directly re-requested", ["Direct review request"]],
      ["No fresh activity", []],
    ],
  },
  {
    lifecycle: "Merged",
    base: -5,
    description: "The PR is merged.",
    scenarios: [
      ["Comment after merge", ["Comment after merge"]],
      ["No post-merge activity", []],
    ],
  },
  {
    lifecycle: "Draft",
    base: -10,
    description: "The PR is still a draft.",
    scenarios: [
      [
        "Re-requested teammate PR with reply, commits, and team request",
        [
          "Direct review request",
          "Teammate authored PR",
          "Reply to your review",
          "New commits",
          "Team review request",
        ],
      ],
      [
        "New teammate PR requesting you",
        ["Direct review request", "Teammate authored PR"],
      ],
      ["Direct review request", ["Direct review request"]],
      ["No fresh activity", []],
    ],
  },
].sort((a, b) => b.base - a.base);

function matchesPrFilter(item, filter) {
  if (filter === "done") return true;
  if (filter === "mine") return item.authored;
  return item.lifecycle === filter;
}

function safeGitHubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.href : "#";
  } catch {
    return "#";
  }
}

function analysisFor(item, pullRequest) {
  const runs = pullRequest?.runs ?? [];
  const active = runs.find((run) => ["queued", "running"].includes(run.status));
  const succeeded = runs.find(
    (run) =>
      run.status === "succeeded" &&
      (!item.headSha || run.headSha === item.headSha),
  );
  return {
    active,
    href: succeeded
      ? `http://127.0.0.1:4173/reviews/${encodeURIComponent(pullRequest.slug)}/`
      : "",
  };
}

function signedScore(value) {
  return value > 0 ? `+${value}` : String(value);
}

function scenarioTotal(base, signals) {
  return base + signals.reduce((total, signal) => total + scoringSignalScores.get(signal), 0);
}

function scoringSectionId(value) {
  return `scoring-${value.toLowerCase().replace(/\W+/g, "-")}`;
}

function relativeTime(date) {
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

function parseList(value) {
  return [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
}

const updatedDateFormatter = new Intl.DateTimeFormat("en", {
  weekday: "long",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function groupByUpdatedDate(items) {
  const groups = new Map();
  for (const item of items) {
    const date = new Date(item.updatedAt);
    const key = date.toDateString();
    const group = groups.get(key) ?? {
      label: Number.isNaN(date.getTime())
        ? "Unknown date"
        : updatedDateFormatter.format(date),
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.items.sort(
      (left, right) =>
        (right.score ?? 0) - (left.score ?? 0) ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
  }
  return [...groups.values()];
}

function SettingsDialog({ open, onOpenChange, settings, onSave }) {
  const [draft, setDraft] = useState({
    username: "",
    people: "",
    teams: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft({
        username: settings.username,
        people: settings.people.join(", "),
        teams: settings.teams.join(", "),
      });
    }
  }, [open, settings]);

  function update(field) {
    return (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    const saved = await onSave({
      username: draft.username.trim(),
      people: parseList(draft.people),
      teams: parseList(draft.teams),
    });
    setSaving(false);
    if (saved) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <p className="eyebrow">Queue inputs</p>
            <DialogTitle>Configure your review orbit</DialogTitle>
            <DialogDescription>
              These lists are saved locally on disk and used to score teammate and GitHub team
              activity.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <label className="text-sm font-semibold" htmlFor="username">
              GitHub username
            </label>
            <Input
              id="username"
              value={draft.username}
              onChange={update("username")}
              placeholder="Auto-detected from gh"
              autoComplete="off"
              pattern="[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
            />
            <p className="field-note">
              Leave blank to use the account currently signed into <code>gh</code>.
            </p>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-semibold" htmlFor="people">
              Teammate usernames
            </label>
            <Input
              id="people"
              value={draft.people}
              onChange={update("people")}
              placeholder="alice, bob, carol"
              autoComplete="off"
            />
            <p className="field-note">Comma-separated. Each teammate-authored PR receives +7.</p>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-semibold" htmlFor="teams">
              GitHub teams
            </label>
            <Input
              id="teams"
              value={draft.teams}
              onChange={update("teams")}
              placeholder="your-org/platform, your-org/mobile"
              autoComplete="off"
            />
            <p className="field-note">Use the full org/team name, separated by commas.</p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save and refresh"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Sidebar({ activeFilter, counts, onFilter, onSettings }) {
  return (
    <aside className="sidebar-panel">
      <div>
        <a className="brand" href="/" aria-label="PR Review Cockpit home">
          <span className="brand-mark" aria-hidden="true">
            <GitPullRequest className="size-5" strokeWidth={2.3} />
          </span>
          <span>
            <strong>Review cockpit</strong>
            <small>Local GitHub queue</small>
          </span>
        </a>

        <Button
          className="mobile-settings"
          size="icon"
          variant="outline"
          onClick={onSettings}
          aria-label="Configure team"
        >
          <Settings2 className="size-4" />
        </Button>

        <nav className="mt-8" aria-label="Queue views">
          {filterGroups.map((group) => (
            <div className="filter-group" key={group.label}>
              <p className="filter-group-label">{group.label}</p>
              {group.filters.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={cn("filter-button", activeFilter === id && "active")}
                  onClick={() => onFilter(id)}
                  type="button"
                >
                  <span className="flex items-center gap-3">
                    <Icon className="size-4" />
                    {label}
                  </span>
                  <strong>{counts[id]}</strong>
                </button>
              ))}
            </div>
          ))}
          <div className="filter-group">
            <p className="filter-group-label">Tools</p>
            <a
              className="filter-button no-underline"
              href="/analyze"
              target="_blank"
              rel="noreferrer"
            >
              <span className="flex items-center gap-3">
                <Sparkles className="size-4" />
                AI analyzer queue
              </span>
              <ArrowUpRight className="size-4" />
            </a>
          </div>
        </nav>
      </div>

      <div className="mt-auto">
        <Button
          className="w-full justify-start border-sidebar-line bg-transparent text-sidebar-muted hover:bg-white/5 hover:text-white"
          variant="outline"
          onClick={onSettings}
        >
          <Settings2 className="size-4" />
          Configure team
        </Button>

        <details className="weight-panel mt-3">
          <summary>
            <span>Scoring layers</span>
            <span aria-hidden="true">+</span>
          </summary>
          <div className="weight-panel-body">
            {scoreLegend.map((section) => (
              <div className="weight-section" key={section.label}>
                <span className="weight-section-label">{section.label}</span>
                <div className="grid gap-2">
                  {section.items.map((item) => (
                    <div
                      className="grid grid-cols-[8px_1fr_auto] items-center gap-2"
                      key={item.label}
                    >
                      <i className={cn("size-1.5 rounded-full", item.color)} />
                      <span>{item.label}</span>
                      <b>{signedScore(item.score)}</b>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <a className="scoring-guide-link" href="/scoring">
              Full scoring table
              <ArrowUpRight className="size-3" />
            </a>
          </div>
        </details>
      </div>
    </aside>
  );
}

function LoadingQueue() {
  return (
    <div className="queue-card grid min-h-72 place-content-center justify-items-center text-center">
      <div className="flex gap-1.5" aria-hidden="true">
        <i className="loading-dot" />
        <i className="loading-dot [animation-delay:120ms]" />
        <i className="loading-dot [animation-delay:240ms]" />
      </div>
      <p className="mt-4 text-sm text-muted-foreground">Building your current review queue…</p>
    </div>
  );
}

function EmptyQueue({ searching, canConfigure, onSettings, error, onRetry }) {
  const Icon = error ? AlertTriangle : Check;
  return (
    <div className="queue-card grid min-h-80 place-content-center justify-items-center px-6 text-center">
      <span
        className={cn(
          "grid size-11 place-items-center rounded-full border bg-background",
          error ? "border-coral/30 text-coral-strong" : "border-primary/25 text-primary",
        )}
      >
        <Icon className="size-5" />
      </span>
      <h2 className="mt-4 font-display text-2xl font-semibold">
        {error
          ? "GitHub could not be loaded"
          : searching
            ? "Nothing matches that search"
            : "This view is clear"}
      </h2>
      <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
        {error ||
          (searching
            ? "Try a repository, author, or different phrase."
            : "No current items match this lifecycle.")}
      </p>
      {error && (
        <Button className="mt-5" onClick={onRetry}>
          Retry
        </Button>
      )}
      {!error && canConfigure && (
        <Button className="mt-5" variant="outline" onClick={onSettings}>
          Add your team
        </Button>
      )}
    </div>
  );
}

function SignalBadge({ signal }) {
  return (
    <Badge className={cn("font-medium", signalStyles[signal.kind])} variant="outline">
      {signal.kind === "review-reply" && <MessageSquareReply className="size-3" />}
      {signal.kind === "post-merge-comment" && <MessageSquare className="size-3" />}
      {signal.kind === "new-commits" && <GitCommitHorizontal className="size-3" />}
      {signal.kind === "direct-mention" && <AtSign className="size-3" />}
      {signal.kind === "my-pr-activity" && <Bell className="size-3" />}
      {signal.kind === "team-review" && <Users className="size-3" />}
      {signal.label}
      {signal.detail && <span className="opacity-65">· {signal.detail}</span>}
      <b className="ml-1 opacity-60">{signedScore(signal.weight)}</b>
    </Badge>
  );
}

function PullRequestRow({
  item,
  completed,
  onToggleDone,
  doneBusy,
  nested,
  analysis,
  analysisBusy,
  onAnalyze,
  onMarkRead,
}) {
  const Title = nested ? "h4" : "h3";
  const labelColor = (color) => (/^[\da-f]{6}$/i.test(color) ? `#${color}` : "#9b948d");
  const reportedUpdates = item.updatesSinceRead ?? [];
  const signalUpdates = item.signals
    .filter((signal) => activitySignalKinds.has(signal.kind))
    .map((signal) => signal.label);
  const updatesSinceRead = reportedUpdates.length || item.read
    ? reportedUpdates.length === 1 &&
      reportedUpdates[0] === "PR activity changed" &&
      signalUpdates.length
      ? signalUpdates
      : reportedUpdates
    : [
        `Pull request opened${item.author ? ` by ${item.author}` : ""}`,
        Number.isInteger(item.additions) && Number.isInteger(item.deletions)
          ? `+${item.additions} −${item.deletions}${Number.isInteger(item.changedFiles) ? ` across ${item.changedFiles} changed ${item.changedFiles === 1 ? "file" : "files"}` : ""}`
          : Number.isInteger(item.changedFiles)
            ? `${item.changedFiles} changed ${item.changedFiles === 1 ? "file" : "files"}`
            : null,
        item.comments > 0
          ? `${item.comments} ${item.comments === 1 ? "comment" : "comments"}`
          : null,
        item.draft ? "Opened as draft" : null,
        item.state === "MERGED" ? "Merged" : null,
      ].filter(Boolean);

  return (
    <article
      className={cn(
        "pr-row",
        item.read && !item.hasUnreadUpdates && "is-read",
        completed && "opacity-60",
      )}
    >
      <div className="pr-update-popover" role="tooltip">
        <strong>Changes since last open</strong>
        {updatesSinceRead.length ? (
          <ul>
            {updatesSinceRead.map((update) => (
              <li key={update}>{update}</li>
            ))}
          </ul>
        ) : (
          <p>No new activity.</p>
        )}
      </div>
      <div className="score-block">
        <Badge className={lifecycleStyles[item.lifecycle]} variant="outline">
          {signedScore(item.lifecycleScore)}
        </Badge>
        <strong>{item.score}</strong>
        <span>total</span>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/65">#{item.number}</span>
          {item.hasUpdates && (
            <Badge className="border-coral/25 bg-coral/10 text-coral-strong" variant="outline">
              <RefreshCw className="size-3" />
              Updated since Done
            </Badge>
          )}
          {item.state !== "OPEN" && <Badge variant="outline">{item.state.toLowerCase()}</Badge>}
        </div>

        <Title className="mt-1.5 text-[17px] font-semibold leading-snug tracking-[-0.015em]">
          <a
            className="decoration-primary/35 underline-offset-4 hover:underline"
            href={safeGitHubUrl(item.actionUrl)}
            target="_blank"
            rel="noreferrer"
            onClick={() => onMarkRead(item)}
          >
            {item.title}
          </a>
        </Title>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {item.notification && (
            <Badge
              className="border-primary/20 bg-primary/8 font-medium text-primary"
              variant="outline"
            >
              <Bell className="size-3" />
              {notificationLabels[item.notification.reason] || "PR notification"}
            </Badge>
          )}
          {item.authored && (
            <Badge
              className="border-lilac/25 bg-lilac/10 font-medium text-lilac-strong"
              variant="outline"
            >
              <GitPullRequest className="size-3" />
              Your PR
            </Badge>
          )}
          {item.signals.map((signal) => (
            <SignalBadge key={signal.kind} signal={signal} />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {item.author && (
            <span>
              by <b className="font-semibold text-foreground/65">{item.author}</b>
            </span>
          )}
          <span>updated {relativeTime(item.updatedAt)}</span>
          {Number.isInteger(item.additions) && Number.isInteger(item.deletions) && (
            <span>{item.additions + item.deletions} changed LoC</span>
          )}
          {Number.isInteger(item.changedFiles) && (
            <span>
              {item.changedFiles} {item.changedFiles === 1 ? "file" : "files"}
            </span>
          )}
          {item.comments > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="size-3" />
              {item.comments}
            </span>
          )}
          {item.labels.map((label) => (
            <span className="inline-flex items-center gap-1.5" key={label.name}>
              <i
                className="size-1.5 rounded-full"
                style={{ backgroundColor: labelColor(label.color) }}
              />
              {label.name}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1.5 md:justify-end">
        {analysis.href ? (
          <a
            className="review-action"
            href={analysis.href}
            target="_blank"
            rel="noreferrer"
            onClick={() => onMarkRead(item)}
          >
            <Sparkles className="size-3.5" />
            Open tree
          </a>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={analysisBusy || Boolean(analysis.active)}
            onClick={() => onAnalyze(item)}
          >
            {analysisBusy || analysis.active?.status === "running" ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {analysisBusy
              ? "Queueing"
              : analysis.active?.status === "running"
                ? "Analyzing"
                : analysis.active
                  ? "Queued"
                  : "Analyze"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={doneBusy}
          onClick={() => onToggleDone(item)}
        >
          {doneBusy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : completed ? (
            <RotateCcw className="size-3.5" />
          ) : (
            <Check className="size-3.5" />
          )}
          {completed ? "Restore" : "Done"}
        </Button>
      </div>
    </article>
  );
}

function NotificationRow({ item, completed, onToggleDone, doneBusy, nested }) {
  const Title = nested ? "h4" : "h3";
  return (
    <article className={cn("notification-row", completed && "opacity-60")}>
      <div className="notification-type">
        <Bell className="size-4" />
        <span>{item.subjectType}</span>
      </div>
      <div className="min-w-0">
        <Title className="text-[17px] font-semibold leading-snug tracking-[-0.015em]">
          <a
            className="decoration-primary/35 underline-offset-4 hover:underline"
            href={safeGitHubUrl(item.url)}
            target="_blank"
            rel="noreferrer"
          >
            {item.title}
          </a>
        </Title>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{notificationLabels[item.reason] || item.reason}</Badge>
          <span>updated {relativeTime(item.updatedAt)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 md:justify-end">
        <a
          className="review-action"
          href={safeGitHubUrl(item.url)}
          target="_blank"
          rel="noreferrer"
        >
          Open
          <ArrowUpRight className="size-3.5" />
        </a>
        <Button
          size="sm"
          variant="outline"
          disabled={doneBusy}
          onClick={() => onToggleDone(item)}
        >
          {doneBusy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : completed ? (
            <RotateCcw className="size-3.5" />
          ) : (
            <Check className="size-3.5" />
          )}
          {completed ? "Restore" : "Done"}
        </Button>
      </div>
    </article>
  );
}

function UpdatedDateGroup({
  label,
  items,
  isDone,
  onToggleDone,
  doneMutation,
  analyses,
  analysisMutation,
  onAnalyze,
  onMarkRead,
  notifications = false,
  nested = false,
}) {
  const Heading = nested ? "h3" : "h2";
  const Row = notifications ? NotificationRow : PullRequestRow;
  return (
    <section className="project-group project-card" aria-label={`${label} items`}>
      <header className="project-header">
        <Heading>
          <FileClock className="size-4" aria-hidden="true" />
          {label}
        </Heading>
        <Badge variant="outline">
          {items.length} {items.length === 1 ? "item" : "items"}
        </Badge>
      </header>
      {items.map((item) => (
        <Row
          key={item.id}
          item={item}
          completed={isDone(item)}
          onToggleDone={onToggleDone}
          doneBusy={doneMutation === item.id}
          nested={nested}
          {...(!notifications && {
            analysis: analysisFor(item, analyses.get(item.url)),
            analysisBusy: analysisMutation === item.id || analysisMutation === "bulk",
            onAnalyze,
            onMarkRead,
          })}
        />
      ))}
    </section>
  );
}

function QueueSection({
  section,
  isDone,
  onToggleDone,
  doneMutation,
  analyses,
  analysisMutation,
  onAnalyze,
  onMarkRead,
  showHeader,
}) {
  const Icon = lifecycleMeta[section.id]?.icon ?? Bell;
  return (
    <section className="lifecycle-section" aria-label={`${section.label} queue`}>
      {showHeader && (
        <header className="lifecycle-header">
          <h2>
            <Icon className="size-4" aria-hidden="true" />
            {section.label}
          </h2>
          <span>
            {section.score != null && (
              <Badge className={lifecycleStyles[section.id]} variant="outline">
                base {signedScore(section.score)}
              </Badge>
            )}
            <Badge variant="outline">{section.count}</Badge>
          </span>
        </header>
      )}
      <div className="project-card-stack">
        {section.groups.map((group) => (
          <UpdatedDateGroup
            key={group.label}
            label={group.label}
            items={group.items}
            isDone={isDone}
            onToggleDone={onToggleDone}
            doneMutation={doneMutation}
            analyses={analyses}
            analysisMutation={analysisMutation}
            onAnalyze={onAnalyze}
            onMarkRead={onMarkRead}
            notifications={section.id === "nonpr"}
            nested={showHeader}
          />
        ))}
      </div>
    </section>
  );
}

function ScoringGuide() {
  return (
    <main className="app-canvas min-h-screen">
      <div className="scoring-page">
        <a className="scoring-back" href="/">
          <ArrowLeft className="size-4" />
          Back to the queue
        </a>

        <header className="mt-10">
          <p className="eyebrow">
            <span className="size-1.5 rounded-full bg-primary" />
            Priority model
          </p>
          <h1 className="font-display text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
            How scoring works
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Every pull request gets one lifecycle base. Unique activity signals are then
            added on top; each signal type counts once per PR.
          </p>
        </header>

        <div className="scoring-formula" aria-label="Scoring formula">
          <strong>Total priority</strong>
          <span>=</span>
          <span>lifecycle base</span>
          <span>+</span>
          <span>activity signals</span>
        </div>

        {scoringScenarioGroups.map(({ lifecycle, base, description, scenarios }) => (
          <section
            className="scoring-sheet"
            aria-labelledby={scoringSectionId(lifecycle)}
            key={lifecycle}
          >
            <header>
              <div>
                <p className="eyebrow">Lifecycle · base {signedScore(base)}</p>
                <h2 id={scoringSectionId(lifecycle)}>{lifecycle}</h2>
              </div>
              <p>{description}</p>
            </header>
            <div className="scoring-table-wrap">
              <table className="scoring-table scoring-scenarios">
                <thead>
                  <tr>
                    <th scope="col">Situation</th>
                    <th scope="col">Base</th>
                    <th scope="col">Signals</th>
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {[...scenarios]
                    .sort(
                      (a, b) =>
                        scenarioTotal(base, b[1]) - scenarioTotal(base, a[1]),
                    )
                    .map(([label, signals]) => (
                      <tr key={label}>
                        <th scope="row">{label}</th>
                        <td>{signedScore(base)}</td>
                        <td>
                          <div className="scenario-signals">
                            {signals.length ? (
                              signals.map((signal) => (
                                <span key={signal}>
                                  {signal} {signedScore(scoringSignalScores.get(signal))}
                                </span>
                              ))
                            ) : (
                              <span>None</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <Badge variant="outline">
                            {signedScore(scenarioTotal(base, signals))}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        <p className="scoring-table-note scoring-page-note">
          These are representative valid combinations, not every permutation. Signals
          remain additive, so any unlisted valid combination uses the same formula.
        </p>

        <p className="scoring-footnote">
          Queue membership and Done state are local. Reading a GitHub notification does not
          remove or reopen a pull request.
        </p>
      </div>
    </main>
  );
}

function QueueApp() {
  const [data, setData] = useState({
    items: [],
    notifications: [],
    username: "",
    fetchedAt: null,
    repositories: [],
    notificationSummary: { total: 0, pullRequests: 0, nonPullRequests: 0 },
    warnings: [],
  });
  const [activeFilter, setActiveFilter] = useState("new");
  const [activeProject, setActiveProject] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(emptySettings);
  const [doneMutation, setDoneMutation] = useState("");
  const [queueActionError, setQueueActionError] = useState("");
  const [analysisDashboard, setAnalysisDashboard] = useState({
    prs: [],
    queue: { activeRunId: null, queuedRunIds: [] },
  });
  const [analysisError, setAnalysisError] = useState("");
  const [analysisMutation, setAnalysisMutation] = useState("");
  const [analysisNotice, setAnalysisNotice] = useState("");

  const isDone = useCallback((item) => Boolean(item.done), []);

  const refresh = useCallback(async (background = false, synchronize = false) => {
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
      if (synchronize) {
        const syncResponse = await fetch(
          synchronize === "notifications"
            ? "/api/inbox/notifications/sync"
            : "/api/inbox/sync",
          { method: "POST" },
        );
        const syncResult = await syncResponse.json();
        if (!syncResponse.ok) throw new Error(syncResult.error);
      }
      const response = await fetch("/api/inbox");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result);
    } catch (caught) {
      if (!background) {
        setError(caught.message || "Check your GitHub CLI login and retry.");
      }
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  const refreshAnalyses = useCallback(async () => {
    try {
      const response = await fetch("/api/analyses");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setAnalysisDashboard(result);
      setAnalysisError("");
    } catch (caught) {
      setAnalysisError(caught.message || "AI analysis service could not be loaded.");
    }
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setSettings(result);
      })
      .catch((caught) => {
        setError(caught.message || "Local settings could not be loaded.");
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(
      () => refresh(true, "notifications"),
      5 * 60_000,
    );
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    refreshAnalyses();
  }, [refreshAnalyses]);

  const analysisRunning = Boolean(
    analysisDashboard.queue?.activeRunId ||
      analysisDashboard.queue?.queuedRunIds?.length,
  );

  useEffect(() => {
    const timer = window.setInterval(
      refreshAnalyses,
      analysisRunning ? 3_000 : 30_000,
    );
    return () => window.clearInterval(timer);
  }, [analysisRunning, refreshAnalyses]);

  const allEntries = useMemo(
    () => [...data.items, ...data.notifications],
    [data.items, data.notifications],
  );
  const openPrs = useMemo(
    () => data.items.filter((item) => !isDone(item)),
    [data.items, isDone],
  );
  const openNotifications = useMemo(
    () => data.notifications.filter((item) => !isDone(item)),
    [data.notifications, isDone],
  );
  const analyses = useMemo(
    () =>
      new Map(
        (analysisDashboard.prs ?? analysisDashboard.pullRequests ?? []).map((pr) => [
          pr.url,
          pr,
        ]),
      ),
    [analysisDashboard],
  );
  const newAnalysisCandidates = useMemo(
    () =>
      data.items.filter((item) => {
        if (item.lifecycle !== "new" || isDone(item)) return false;
        const analysis = analysisFor(item, analyses.get(item.url));
        return !analysis.active && !analysis.href;
      }),
    [analyses, data.items, isDone],
  );
  const counts = useMemo(
    () => ({
      reviewed: openPrs.filter((item) => item.lifecycle === "reviewed").length,
      new: openPrs.filter((item) => item.lifecycle === "new").length,
      approved: openPrs.filter((item) => item.lifecycle === "approved").length,
      merged: openPrs.filter((item) => item.lifecycle === "merged").length,
      draft: openPrs.filter((item) => item.lifecycle === "draft").length,
      mine: openPrs.filter((item) => item.authored).length,
      other: openPrs.filter((item) => item.lifecycle === "other" && !item.authored).length,
      nonpr: openNotifications.length,
      done: allEntries.filter(isDone).length,
    }),
    [allEntries, isDone, openNotifications.length, openPrs],
  );

  const availableProjects = useMemo(() => {
    const completed = activeFilter === "done";
    const entries = [
      ...data.items.filter(
        (item) =>
          isDone(item) === completed && matchesPrFilter(item, activeFilter),
      ),
      ...data.notifications.filter(
        (item) =>
          isDone(item) === completed &&
          ["nonpr", "done"].includes(activeFilter),
      ),
    ];
    const countsByProject = new Map();
    for (const item of entries) {
      countsByProject.set(item.repository, (countsByProject.get(item.repository) ?? 0) + 1);
    }
    return data.repositories.map((repository) => ({
      repository,
      count: countsByProject.get(repository) ?? 0,
    }));
  }, [activeFilter, data.items, data.notifications, data.repositories, isDone]);

  const selectedProject = data.repositories.includes(activeProject)
    ? activeProject
    : (data.repositories[0] ?? "");

  const { visiblePrs, visibleNotifications } = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = (item) =>
      !query ||
      `${item.title} ${item.repository} ${item.author ?? ""} ${item.subjectType ?? ""}`
        .toLowerCase()
        .includes(query);
    const completed = activeFilter === "done";
    const prs = data.items
      .filter((item) => {
        if (isDone(item) !== completed) return false;
        if (!matches(item)) return false;
        if (selectedProject && item.repository !== selectedProject) return false;
        return matchesPrFilter(item, activeFilter);
      })
      .sort(
        (a, b) =>
          new Date(b.updatedAt) - new Date(a.updatedAt) || b.score - a.score,
      );
    const notifications = data.notifications
      .filter(
        (item) =>
          isDone(item) === completed &&
          (!selectedProject || item.repository === selectedProject) &&
          matches(item) &&
          ["nonpr", "done"].includes(activeFilter),
      )
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return { visiblePrs: prs, visibleNotifications: notifications };
  }, [activeFilter, data.items, data.notifications, isDone, search, selectedProject]);

  const queueSections = useMemo(() => {
    const showAllGroups = activeFilter === "done";
    if (showAllGroups) {
      const sections = lifecycleOrder
        .map((id) => {
          const items = visiblePrs.filter((item) => item.lifecycle === id);
          return {
            id,
            label: lifecycleMeta[id].label,
            score: lifecycleMeta[id].score,
            count: items.length,
            groups: groupByUpdatedDate(items),
          };
        })
        .filter((section) => section.count);
      if (visibleNotifications.length) {
        sections.push({
          id: "nonpr",
          label: "Non-PR notifications",
          score: null,
          count: visibleNotifications.length,
          groups: groupByUpdatedDate(visibleNotifications),
        });
      }
      return sections;
    }

    const items = activeFilter === "nonpr" ? visibleNotifications : visiblePrs;
    return [
      {
        id: activeFilter,
        label: lifecycleMeta[activeFilter]?.label ?? "Queue",
        score: activeFilter === "mine" ? null : (lifecycleMeta[activeFilter]?.score ?? null),
        count: items.length,
        groups: groupByUpdatedDate(items),
      },
    ];
  }, [activeFilter, visibleNotifications, visiblePrs]);

  const title = {
    reviewed: "Pull requests you reviewed",
    new: "New and unreviewed",
    approved: "Pull requests you approved",
    merged: "Merged pull requests",
    draft: "Draft pull requests",
    mine: "My pull requests",
    other: "Other PR notifications",
    nonpr: "Non-PR notifications",
    done: "Completed from this queue",
  }[activeFilter];

  async function saveSettings(nextSettings) {
    setError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextSettings),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setSettings(result);
      await refresh();
      return true;
    } catch (caught) {
      setError(caught.message || "Local settings could not be saved.");
      return false;
    }
  }

  async function analyze(item) {
    setAnalysisMutation(item.id);
    setAnalysisError("");
    setAnalysisNotice("");
    try {
      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setAnalysisNotice(`Queued AI analysis for #${item.number}.`);
      await refreshAnalyses();
    } catch (caught) {
      setAnalysisError(caught.message || "AI analysis could not be queued.");
    } finally {
      setAnalysisMutation("");
    }
  }

  async function analyzeNewPullRequests() {
    setAnalysisMutation("bulk");
    setAnalysisError("");
    setAnalysisNotice("");
    try {
      const response = await fetch("/api/analyses/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pullRequests: newAnalysisCandidates }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setAnalysisNotice(
        result.runs.length
          ? `Queued ${result.runs.length} new ${result.runs.length === 1 ? "PR" : "PRs"}, smallest first.`
          : "All new PRs already have a current analysis.",
      );
      await refreshAnalyses();
    } catch (caught) {
      setAnalysisError(caught.message || "The morning analysis queue could not be started.");
    } finally {
      setAnalysisMutation("");
    }
  }

  async function markRead(item) {
    if (item.read) return;
    try {
      const response = await fetch("/api/inbox/items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, read: true }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData((current) => ({
        ...current,
        items: current.items.map((entry) =>
          entry.id === result.id ? { ...entry, ...result } : entry,
        ),
      }));
    } catch (caught) {
      setQueueActionError(caught.message || "Read state could not be saved.");
    }
  }

  async function toggleDone(item) {
    setDoneMutation(item.id);
    setQueueActionError("");
    try {
      const response = await fetch("/api/inbox/items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, done: !item.done }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const update = (entry) =>
        entry.id === result.id ? { ...entry, ...result } : entry;
      setData((current) => ({
        ...current,
        items: current.items.map(update),
        notifications: current.notifications.map(update),
      }));
    } catch (caught) {
      setQueueActionError(caught.message || "Done state could not be saved.");
    } finally {
      setDoneMutation("");
    }
  }

  const visibleCount = visiblePrs.length + visibleNotifications.length;
  const visibleScore = visiblePrs.reduce((total, item) => total + item.score, 0);
  const showLifecycleHeaders = activeFilter === "done";

  return (
    <div className="app-canvas min-h-screen">
      <Sidebar
        activeFilter={activeFilter}
        counts={counts}
        onFilter={setActiveFilter}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className="lg:pl-[17rem]">
        <div className="mx-auto w-full max-w-[1240px] px-5 pb-20 pt-8 sm:px-8 lg:px-12 lg:pt-12">
          <header className="flex flex-col justify-between gap-6 sm:flex-row sm:items-start">
            <div>
              <p className="eyebrow">
                <span className="size-1.5 rounded-full bg-primary" />
                Review queue
              </p>
              <h1 className="font-display text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
                {title}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">
                {error
                  ? "The local page is running, but its data could not be loaded."
                  : data.fetchedAt
                    ? `Signed in as ${data.username} · refreshed ${relativeTime(data.fetchedAt)}.`
                    : "Lifecycle first, fresh activity added on top."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={
                  loading ||
                  Boolean(analysisMutation) ||
                  newAnalysisCandidates.length === 0
                }
                onClick={analyzeNewPullRequests}
              >
                {analysisMutation === "bulk" ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ListPlus className="size-4" />
                )}
                {analysisMutation === "bulk"
                  ? "Queueing…"
                  : `Analyze new PRs${newAnalysisCandidates.length ? ` · ${newAnalysisCandidates.length}` : ""}`}
              </Button>
              <Button
                className="w-fit"
                disabled={loading}
                onClick={() => refresh(false, true)}
              >
                <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                Refresh GitHub
              </Button>
            </div>
          </header>

          {data.repositories.length > 0 && (
            <div className="project-tabs mt-10" role="tablist" aria-label="Repositories">
              {availableProjects.map((project) => (
                <button
                  className={cn(
                    "project-tab",
                    selectedProject === project.repository && "active",
                  )}
                  key={project.repository}
                  type="button"
                  role="tab"
                  aria-selected={selectedProject === project.repository}
                  title={project.repository}
                  onClick={() => setActiveProject(project.repository)}
                >
                  {project.repository.split("/").at(-1)}
                  <span>{project.count}</span>
                </button>
              ))}
            </div>
          )}

          <section
            className={cn("queue-toolbar", data.repositories.length ? "mt-3" : "mt-10")}
            aria-label="Queue controls"
          >
            <label className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="sr-only">Search the queue</span>
              <Input
                className="border-0 bg-transparent pl-10 shadow-none focus-visible:ring-0"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title, repo, author, or type"
              />
            </label>
            <div className="hidden items-center gap-5 border-l border-border pl-5 text-xs text-muted-foreground sm:flex">
              <span>
                <b className="font-semibold text-foreground">{visibleCount}</b> items
              </span>
              <span>
                <b className="font-semibold text-foreground">{visibleScore}</b> total score
              </span>
            </div>
          </section>

          {data.warnings.length > 0 && (
            <div className="mt-4 grid gap-2" aria-live="polite">
              {data.warnings.map((warning) => (
                <p
                  className="flex items-center gap-2 rounded-lg border border-ochre/25 bg-ochre/10 px-3 py-2 text-xs text-ochre-strong"
                  key={warning}
                >
                  <AlertTriangle className="size-3.5" />
                  {warning}
                </p>
              ))}
            </div>
          )}

          {queueActionError && (
            <p
              className="mt-4 flex items-center gap-2 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong"
              aria-live="polite"
            >
              <AlertTriangle className="size-3.5" />
              {queueActionError}
            </p>
          )}

          {(analysisError || analysisNotice) && (
            <p
              className={cn(
                "mt-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
                analysisError
                  ? "border-coral/25 bg-coral/10 text-coral-strong"
                  : "border-sky/25 bg-sky/10 text-sky-strong",
              )}
              aria-live="polite"
            >
              {analysisError ? (
                <AlertTriangle className="size-3.5" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {analysisError || analysisNotice}
            </p>
          )}

          <div className="queue-stack mt-4" aria-live="polite">
            {loading ? (
              <LoadingQueue />
            ) : error ? (
              <EmptyQueue error={error} onRetry={() => refresh()} />
            ) : visibleCount ? (
              queueSections.map((section) => (
                <QueueSection
                  key={section.id}
                  section={section}
                  isDone={isDone}
                  onToggleDone={toggleDone}
                  doneMutation={doneMutation}
                  analyses={analyses}
                  analysisMutation={analysisMutation}
                  onAnalyze={analyze}
                  onMarkRead={markRead}
                  showHeader={showLifecycleHeaders}
                />
              ))
            ) : (
              <EmptyQueue
                searching={Boolean(search)}
                canConfigure={!search && !settings.people.length && !settings.teams.length}
                onSettings={() => setSettingsOpen(true)}
              />
            )}
          </div>
        </div>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSave={saveSettings}
      />
    </div>
  );
}

const terminalAnalysisStatuses = new Set([
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
]);

const analysisStatusStyles = {
  running: "border-sky/25 bg-sky/10 text-sky-strong",
  queued: "border-lilac/25 bg-lilac/10 text-lilac-strong",
  "not-started": "border-border bg-muted text-muted-foreground",
  succeeded: "border-emerald-700/20 bg-emerald-700/10 text-emerald-800",
  failed: "border-coral/25 bg-coral/10 text-coral-strong",
  canceled: "border-border bg-muted text-muted-foreground",
  interrupted: "border-ochre/25 bg-ochre/10 text-ochre-strong",
};

function AnalysisRow({ canceling, entry, mode, onCancel }) {
  const run = mode === "running"
    ? entry.runningRun
    : mode === "queued"
      ? entry.queuedRuns[0]
      : entry.latestRun;
  const status = run?.status ?? "not-started";
  const item = entry.queueItem;
  const metrics = run?.metrics ?? {};
  const changedLines = Number.isInteger(item?.additions) && Number.isInteger(item?.deletions)
    ? item.additions + item.deletions
    : Number.isInteger(metrics.changedLines)
      ? metrics.changedLines
      : Number.isInteger(metrics.additions) && Number.isInteger(metrics.deletions)
        ? metrics.additions + metrics.deletions
        : null;
  const changedFiles = Number.isInteger(item?.changedFiles)
    ? item.changedFiles
    : Number.isInteger(metrics.changedFiles)
      ? metrics.changedFiles
      : null;
  const successfulRun = entry.runs.find((candidate) => candidate.status === "succeeded");
  const detail = mode === "queued"
    ? `#${entry.queuePosition + 1} in queue`
    : mode === "running"
      ? run.currentStage || run.phase || "Analyzing"
      : mode === "not-started"
        ? "Not queued"
        : run.completedAt || run.updatedAt
        ? `finished ${relativeTime(run.completedAt || run.updatedAt)}`
        : "finished";

  return (
    <article className="grid gap-4 rounded-xl border border-border bg-card/80 p-4 shadow-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/65">
            {entry.pr.owner}/{entry.pr.repo} #{entry.pr.number}
          </span>
          <Badge className={analysisStatusStyles[status]} variant="outline">
            {mode === "running" && <LoaderCircle className="size-3 animate-spin" />}
            {status.replace("-", " ")}
          </Badge>
          <span>{detail}</span>
        </div>
        <h3 className="mt-1.5 text-[17px] font-semibold leading-snug tracking-[-0.015em]">
          {entry.title}
        </h3>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {changedLines != null && <span>{changedLines} changed LoC</span>}
          {changedFiles != null && (
            <span>{changedFiles} {changedFiles === 1 ? "file" : "files"}</span>
          )}
          {entry.runs.length > 0 && (
            <span>{entry.runs.length} {entry.runs.length === 1 ? "run" : "runs"}</span>
          )}
        </div>
        {run?.error?.message && (
          <p className="mt-2 max-w-3xl truncate text-xs text-coral-strong" title={run.error.message}>
            {run.error.message}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        {run && ["running", "queued"].includes(mode) && (
          <Button
            className="text-coral-strong"
            disabled={canceling}
            onClick={() => onCancel(
              (mode === "queued" ? entry.queuedRuns : [run])
                .map((candidate) => ({ entry, run: candidate })),
            )}
            size="sm"
            variant="ghost"
          >
            <X className="size-3.5" />
            Cancel
          </Button>
        )}
        {successfulRun && (
          <a
            className="review-action"
            href={`http://127.0.0.1:4173/reviews/${encodeURIComponent(entry.pr.slug)}/`}
            target="_blank"
            rel="noreferrer"
          >
            <Sparkles className="size-3.5" />
            Open tree
          </a>
        )}
        <a
          className="review-action"
          href={safeGitHubUrl(entry.pr.url)}
          target="_blank"
          rel="noreferrer"
        >
          GitHub
          <ArrowUpRight className="size-3.5" />
        </a>
      </div>
    </article>
  );
}

function AnalysisSection({ canceling, description, entries, mode, onCancel, title }) {
  return (
    <section className="mt-8" aria-labelledby={`analysis-${mode}`}>
      <header className="mb-3 flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{description}</p>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.035em]" id={`analysis-${mode}`}>
            {title}
          </h2>
        </div>
        <Badge variant="outline">{entries.length}</Badge>
      </header>
      <div className="grid gap-3">
        {entries.length ? (
          entries.map((entry) => (
            <AnalysisRow
              canceling={canceling}
              entry={entry}
              key={`${mode}-${entry.pr.slug || entry.pr.url}`}
              mode={mode}
              onCancel={onCancel}
            />
          ))
        ) : (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No {title.toLowerCase()}.
          </p>
        )}
      </div>
    </section>
  );
}

function AnalyzerPage() {
  const [dashboard, setDashboard] = useState({ prs: [], queue: {} });
  const [queueItems, setQueueItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState("");

  const refreshDashboard = useCallback(async () => {
    try {
      const response = await fetch("/api/analyses");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setDashboard(result);
      setError("");
    } catch (caught) {
      setError(caught.message || "AI analysis status could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDashboard();
    fetch("/api/inbox")
      .then((response) => response.json())
      .then((inbox) => setQueueItems(inbox.items ?? []))
      .catch(() => {});
  }, [refreshDashboard]);

  const analysisRunning = Boolean(
    dashboard.queue?.activeRunId || dashboard.queue?.queuedRunIds?.length,
  );

  useEffect(() => {
    const timer = window.setInterval(refreshDashboard, analysisRunning ? 3_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [analysisRunning, refreshDashboard]);

  const entries = useMemo(() => {
    const itemsByUrl = new Map(queueItems.map((item) => [item.url, item]));
    const queueOrder = new Map(
      (dashboard.queue?.queuedRunIds ?? []).map((runId, index) => [runId, index]),
    );
    const pullRequests = dashboard.prs ?? dashboard.pullRequests ?? [];
    const dashboardEntries = pullRequests.map((pr) => {
      const runs = [...(pr.runs ?? [])].sort(
        (left, right) =>
          new Date(right.createdAt || right.queuedAt) -
          new Date(left.createdAt || left.queuedAt),
      );
      const queueItem = itemsByUrl.get(pr.url);
      const runningRun = runs.find((run) => run.status === "running");
      const queuedRuns = runs
        .filter((run) => run.status === "queued")
        .sort((left, right) =>
          (queueOrder.get(left.runId) ?? Number.MAX_SAFE_INTEGER) -
          (queueOrder.get(right.runId) ?? Number.MAX_SAFE_INTEGER),
        );
      const latestRun = runs.find((run) => terminalAnalysisStatuses.has(run.status));
      const entry = {
        pr,
        runs,
        queueItem,
        runningRun,
        queuedRuns,
        latestRun,
        queuePosition: queueOrder.get(queuedRuns[0]?.runId) ?? Number.MAX_SAFE_INTEGER,
        title: queueItem?.title || pr.title || runs.find((run) => run.title)?.title || `Pull request #${pr.number}`,
      };
      return { ...entry, state: analysisState(entry) };
    });
    const dashboardUrls = new Set(pullRequests.map((pr) => pr.url));
    const notStarted = queueItems
      .filter((item) => !item.done && !dashboardUrls.has(item.url))
      .map((item) => {
        const [owner, repo] = item.repository.split("/");
        const entry = {
          pr: { number: item.number, owner, repo, slug: "", url: item.url },
          runs: [],
          queueItem: item,
          runningRun: null,
          queuedRuns: [],
          latestRun: null,
          queuePosition: Number.MAX_SAFE_INTEGER,
          title: item.title,
        };
        return { ...entry, state: analysisState(entry) };
      });
    return [...dashboardEntries, ...notStarted];
  }, [dashboard, queueItems]);

  const running = entries
    .filter((entry) => entry.state === "running")
    .sort((left, right) => Number(right.runningRun.runId === dashboard.queue?.activeRunId) - Number(left.runningRun.runId === dashboard.queue?.activeRunId));
  const queued = entries
    .filter((entry) => entry.state === "queued")
    .sort((left, right) => left.queuePosition - right.queuePosition);
  const completed = entries
    .filter((entry) => entry.state === "completed")
    .sort((left, right) =>
      new Date(right.latestRun.completedAt || right.latestRun.updatedAt) -
      new Date(left.latestRun.completedAt || left.latestRun.updatedAt),
    );
  const failed = entries
    .filter((entry) => entry.state === "failed")
    .sort((left, right) =>
      new Date(right.latestRun.completedAt || right.latestRun.updatedAt) -
      new Date(left.latestRun.completedAt || left.latestRun.updatedAt),
    );
  const notStarted = entries.filter((entry) => entry.state === "not-started");

  const cancelRuns = useCallback(async (targets) => {
    setCanceling(true);
    setError("");
    let failure;
    try {
      for (const { entry, run } of targets) {
        const response = await fetch(
          `/api/runs/${encodeURIComponent(entry.pr.slug)}/${encodeURIComponent(run.runId)}/cancel`,
          { method: "POST" },
        );
        if (!response.ok && response.status !== 404) {
          const body = await response.json().catch(() => ({}));
          failure = body.error || "Analysis could not be canceled.";
        }
      }
    } catch (caught) {
      failure = caught.message || "Analysis could not be canceled.";
    } finally {
      await refreshDashboard();
      if (failure) setError(failure);
      setCanceling(false);
    }
  }, [refreshDashboard]);

  const cancelAll = useCallback(() => cancelRuns([
    ...queued.flatMap((entry) => entry.queuedRuns.map((run) => ({ entry, run }))),
    ...running.map((entry) => ({ entry, run: entry.runningRun })),
  ]), [cancelRuns, queued, running]);

  return (
    <div className="app-shell min-h-screen bg-background">
      <aside className="sidebar-panel">
        <div>
          <a className="brand" href="/reviews" aria-label="PR Review Cockpit home">
            <span className="brand-mark" aria-hidden="true">
              <GitPullRequest className="size-5" strokeWidth={2.3} />
            </span>
            <span>
              <strong>Review cockpit</strong>
              <small>Local GitHub queue</small>
            </span>
          </a>
          <nav className="mt-8" aria-label="Analyzer navigation">
            <div className="filter-group">
              <p className="filter-group-label">Navigate</p>
              <a className="filter-button no-underline" href="/reviews">
                <span className="flex items-center gap-3">
                  <ArrowLeft className="size-4" />
                  Review queue
                </span>
              </a>
              <a className="filter-button active no-underline" href="/analyze">
                <span className="flex items-center gap-3">
                  <Sparkles className="size-4" />
                  AI analyzer queue
                </span>
                <strong>{running.length + queued.length}</strong>
              </a>
            </div>
          </nav>
        </div>
      </aside>

      <main className="lg:pl-[17rem]">
        <div className="mx-auto w-full max-w-[1240px] px-5 pb-20 pt-8 sm:px-8 lg:px-12 lg:pt-12">
          <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
            <div>
              <p className="eyebrow">
                <span className="size-1.5 rounded-full bg-primary" />
                AI analyzer
              </p>
              <h1 className="font-display text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
                Analysis queue
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                One highest-effort analysis at a time, with the smallest PRs first.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="text-coral-strong"
                disabled={canceling || !analysisRunning}
                onClick={cancelAll}
                variant="outline"
              >
                <X className="size-4" />
                Cancel all
              </Button>
              <Button variant="outline" disabled={loading} onClick={refreshDashboard}>
                <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </header>

          {error && (
            <p className="mt-5 flex items-center gap-2 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong">
              <AlertTriangle className="size-3.5" />
              {error}
            </p>
          )}

          <AnalysisSection canceling={canceling} description="Current work" entries={running} mode="running" onCancel={cancelRuns} title="In progress" />
          <AnalysisSection canceling={canceling} description="Smallest first" entries={queued} mode="queued" onCancel={cancelRuns} title="In queue" />
          <AnalysisSection canceling={canceling} description="No analysis yet" entries={notStarted} mode="not-started" onCancel={cancelRuns} title="Not started" />
          <AnalysisSection canceling={canceling} description="Successful analyses" entries={completed} mode="completed" onCancel={cancelRuns} title="Completed" />
          <AnalysisSection canceling={canceling} description="Failed, canceled, or interrupted" entries={failed} mode="failed" onCancel={cancelRuns} title="Failed" />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  if (window.location.pathname.startsWith("/analyze")) return <AnalyzerPage />;
  return window.location.pathname.startsWith("/scoring") ? <ScoringGuide /> : <QueueApp />;
}
