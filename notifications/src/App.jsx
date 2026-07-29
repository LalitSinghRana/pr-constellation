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
  FolderGit2,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Inbox,
  MessageSquare,
  MessageSquareReply,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Users,
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
import { cn } from "./lib/utils";

const storageKey = "pr-cockpit-done";
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
    label: "Inbox",
    filters: [{ id: "everything", label: "Everything", icon: Inbox }],
  },
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
      { label: "Reply / mention", score: 6, color: "bg-sky" },
      { label: "Activity on my PR", score: 5, color: "bg-ochre" },
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
  ["Direct mention", 6, "Someone mentions your GitHub username."],
  ["Activity on your PR", 5, "Your open PR has an unread GitHub notification."],
  ["New commits", 3, "Commits landed after your latest review."],
  ["Team review request", 3, "A configured GitHub team is requested."],
  ["New comments", 2, "General comments arrived after your latest review."],
  ["Team mention", 2, "A configured GitHub team is mentioned."],
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
        "Teammate PR requesting you and your team, with a direct mention",
        [
          "Direct review request",
          "Teammate authored PR",
          "Direct mention",
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
    scenarios: [
      [
        "Unread activity with a mention and team coverage",
        [
          "Activity on your PR",
          "Direct mention",
          "Team review request",
          "Covered by teammate",
        ],
      ],
      [
        "Unread activity with a direct mention",
        ["Activity on your PR", "Direct mention"],
      ],
      ["Unread activity", ["Activity on your PR"]],
      ["No unread notification", []],
    ],
  },
  {
    lifecycle: "Other notification PR",
    base: 0,
    description: "Unread PR notification with no recognized positive signal.",
    scenarios: [["Unmatched unread notification", []]],
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
      [
        "Your draft with unread activity and a mention",
        ["Activity on your PR", "Direct mention"],
      ],
      ["Direct review request", ["Direct review request"]],
      ["No fresh activity", []],
    ],
  },
].sort((a, b) => b.base - a.base);

function readDone() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) ?? {};
  } catch {
    return {};
  }
}

function writeDone(value) {
  localStorage.setItem(storageKey, JSON.stringify(value));
}

function matchesPrFilter(item, filter) {
  if (["everything", "done"].includes(filter)) return true;
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

function signedScore(value) {
  return value > 0 ? `+${value}` : String(value);
}

function scenarioTotal(base, signals) {
  return base + signals.reduce((total, signal) => total + scoringSignalScores.get(signal), 0);
}

function scoringSectionId(value) {
  return `scoring-${value.toLowerCase().replace(/\W+/g, "-")}`;
}

function fingerprint(item) {
  const signals = (item.signals ?? []).map((signal) => signal.kind).sort().join(",");
  return `${item.updatedAt}:${item.lifecycle ?? item.subjectType}:${item.score ?? ""}:${signals}`;
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

function groupByRepository(items) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.repository) ?? [];
    group.push(item);
    groups.set(item.repository, group);
  }
  return [...groups].map(([repository, groupedItems]) => ({
    repository,
    items: groupedItems,
  }));
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

function PullRequestRow({ item, completed, onToggleDone, nested }) {
  const Title = nested ? "h4" : "h3";
  const labelColor = (color) => (/^[\da-f]{6}$/i.test(color) ? `#${color}` : "#9b948d");

  return (
    <article className={cn("pr-row", completed && "opacity-60")}>
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
          <Badge className={lifecycleStyles[item.lifecycle]} variant="outline">
            {item.lifecycleLabel}
          </Badge>
          {item.state !== "OPEN" && <Badge variant="outline">{item.state.toLowerCase()}</Badge>}
        </div>

        <Title className="mt-1.5 text-[17px] font-semibold leading-snug tracking-[-0.015em]">
          <a
            className="decoration-primary/35 underline-offset-4 hover:underline"
            href={safeGitHubUrl(item.actionUrl)}
            target="_blank"
            rel="noreferrer"
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
        <a
          className="review-action"
          href={safeGitHubUrl(item.actionUrl)}
          target="_blank"
          rel="noreferrer"
        >
          Review
          <ArrowUpRight className="size-3.5" />
        </a>
        <Button size="sm" variant="outline" onClick={() => onToggleDone(item)}>
          {completed ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
          {completed ? "Restore" : "Done"}
        </Button>
      </div>
    </article>
  );
}

function NotificationRow({ item, completed, onToggleDone, nested }) {
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
        <Button size="sm" variant="outline" onClick={() => onToggleDone(item)}>
          {completed ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
          {completed ? "Restore" : "Done"}
        </Button>
      </div>
    </article>
  );
}

function ProjectGroup({
  repository,
  items,
  isDone,
  onToggleDone,
  notifications = false,
  nested = false,
}) {
  const Heading = nested ? "h3" : "h2";
  const Row = notifications ? NotificationRow : PullRequestRow;
  return (
    <section className="project-group project-card" aria-label={`${repository} items`}>
      <header className="project-header">
        <Heading>
          <FolderGit2 className="size-4" aria-hidden="true" />
          {repository}
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
          nested={nested}
        />
      ))}
    </section>
  );
}

function QueueSection({ section, isDone, onToggleDone, showHeader }) {
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
          <ProjectGroup
            key={group.repository}
            repository={group.repository}
            items={group.items}
            isDone={isDone}
            onToggleDone={onToggleDone}
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
          remain additive, so any unlisted valid combination uses the same formula. A
          recognized positive signal moves an otherwise unmatched notification PR into New
          / unreviewed.
        </p>

        <p className="scoring-footnote">
          Marking a GitHub notification Done removes it from this queue. Your own open PR
          remains visible at its base score even without a notification.
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
    notificationSummary: { total: 0, pullRequests: 0, nonPullRequests: 0 },
    warnings: [],
  });
  const [activeFilter, setActiveFilter] = useState("everything");
  const [activeProject, setActiveProject] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(emptySettings);
  const [settingsReady, setSettingsReady] = useState(false);
  const [done, setDone] = useState(readDone);

  const isDone = useCallback((item) => done[item.id] === fingerprint(item), [done]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/inbox");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result);
    } catch (caught) {
      setError(caught.message || "Check your GitHub CLI login and retry.");
    } finally {
      setLoading(false);
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
        setLoading(false);
      })
      .finally(() => setSettingsReady(true));
  }, []);

  useEffect(() => {
    if (settingsReady) refresh();
  }, [refresh, settingsReady]);

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
  const counts = useMemo(
    () => ({
      everything: openPrs.length + openNotifications.length,
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
          ["everything", "nonpr", "done"].includes(activeFilter),
      ),
    ];
    const countsByProject = new Map();
    for (const item of entries) {
      countsByProject.set(item.repository, (countsByProject.get(item.repository) ?? 0) + 1);
    }
    return [...countsByProject]
      .map(([repository, count]) => ({ repository, count }))
      .sort((a, b) => a.repository.localeCompare(b.repository));
  }, [activeFilter, data.items, data.notifications, isDone]);

  const selectedProject = availableProjects.some(
    (project) => project.repository === activeProject,
  )
    ? activeProject
    : (availableProjects[0]?.repository ?? "");

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
      .sort((a, b) => b.score - a.score || new Date(b.updatedAt) - new Date(a.updatedAt));
    const notifications = data.notifications
      .filter(
        (item) =>
          isDone(item) === completed &&
          (!selectedProject || item.repository === selectedProject) &&
          matches(item) &&
          ["everything", "nonpr", "done"].includes(activeFilter),
      )
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return { visiblePrs: prs, visibleNotifications: notifications };
  }, [activeFilter, data.items, data.notifications, isDone, search, selectedProject]);

  const queueSections = useMemo(() => {
    const showAllGroups = ["everything", "done"].includes(activeFilter);
    if (showAllGroups) {
      const sections = lifecycleOrder
        .map((id) => {
          const items = visiblePrs.filter((item) => item.lifecycle === id);
          return {
            id,
            label: lifecycleMeta[id].label,
            score: lifecycleMeta[id].score,
            count: items.length,
            groups: groupByRepository(items),
          };
        })
        .filter((section) => section.count);
      if (visibleNotifications.length) {
        sections.push({
          id: "nonpr",
          label: "Non-PR notifications",
          score: null,
          count: visibleNotifications.length,
          groups: groupByRepository(visibleNotifications),
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
        groups: groupByRepository(items),
      },
    ];
  }, [activeFilter, visibleNotifications, visiblePrs]);

  const title = {
    everything: "Everything in your orbit",
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

  function toggleDone(item) {
    setDone((current) => {
      const next = { ...current };
      if (next[item.id] === fingerprint(item)) delete next[item.id];
      else next[item.id] = fingerprint(item);
      writeDone(next);
      return next;
    });
  }

  const visibleCount = visiblePrs.length + visibleNotifications.length;
  const visibleScore = visiblePrs.reduce((total, item) => total + item.score, 0);
  const showLifecycleHeaders = ["everything", "done"].includes(activeFilter);

  return (
    <div className="app-canvas min-h-screen">
      <Sidebar
        activeFilter={activeFilter}
        counts={counts}
        onFilter={(filter) => {
          setActiveFilter(filter);
          setActiveProject("");
        }}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className="lg:pl-[17rem]">
        <div className="mx-auto w-full max-w-[1240px] px-5 pb-20 pt-8 sm:px-8 lg:px-12 lg:pt-12">
          <header className="flex flex-col justify-between gap-6 sm:flex-row sm:items-start">
            <div>
              <p className="eyebrow">
                <span className="size-1.5 rounded-full bg-primary" />
                {activeFilter === "everything" ? "Unified inbox" : "Lifecycle view"}
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
            <Button className="w-fit" disabled={loading} onClick={refresh}>
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              Refresh GitHub
            </Button>
          </header>

          {availableProjects.length > 1 && (
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
            className={cn("queue-toolbar", availableProjects.length > 1 ? "mt-3" : "mt-10")}
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
              {activeFilter === "everything" && (
                <span>
                  <b className="font-semibold text-foreground">
                    {data.notificationSummary?.total ?? 0}
                  </b>{" "}
                  GitHub unread
                </span>
              )}
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

          <div className="queue-stack mt-4" aria-live="polite">
            {loading ? (
              <LoadingQueue />
            ) : error ? (
              <EmptyQueue error={error} onRetry={refresh} />
            ) : visibleCount ? (
              queueSections.map((section) => (
                <QueueSection
                  key={section.id}
                  section={section}
                  isDone={isDone}
                  onToggleDone={toggleDone}
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

export default function App() {
  return window.location.pathname.startsWith("/scoring") ? <ScoringGuide /> : <QueueApp />;
}
