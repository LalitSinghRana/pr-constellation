import {
  Check,
  CircleDot,
  CircleX,
  FileText,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  MessageSquare,
  RotateCcw,
  UserRoundPlus,
} from "lucide-react";
import { Timeline } from "primereact/timeline";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { remarkAlert } from "remark-github-blockquote-alert";
import { useQuery } from "../hooks/use-query.js";
import { cn } from "../lib/utils.js";
import { githubMarkdownSanitizeSchema } from "./github-markdown.js";

export function PullRequestConversation({ review, reviewSlug }) {
  const {
    data: conversation,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["review-conversation", reviewSlug],
    queryFn: async ({ queryKey, signal }) => {
      const slug = queryKey[1];
      const response = await fetch(`/api/reviews/${encodeURIComponent(slug)}/conversation`, {
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Conversation could not be loaded.");
      }
      return payload;
    },
  });

  if (error) return <p className="m-auto text-sm text-destructive">{error.message}</p>;
  if (isLoading || !conversation) {
    return <p className="m-auto text-sm text-muted-foreground">Loading conversation…</p>;
  }

  const timeline = [
    ...(review.body.trim()
      ? [
          {
            actor: review.authorLogin || "Author",
            avatarUrl: review.authorAvatarUrl,
            body: review.body,
            createdAt: review.createdAt,
            kind: "description",
            type: "PullRequest",
            url: review.url,
          },
        ]
      : []),
    ...conversation.timeline,
    ...conversation.threads.map((thread) => ({
      actor: thread.comments[0]?.actor || "GitHub",
      avatarUrl: thread.comments[0]?.avatarUrl || "",
      createdAt: thread.comments[0]?.createdAt || "",
      kind: "thread",
      thread,
      type: "PullRequestReviewThread",
    })),
  ].sort((left, right) => timelineTimestamp(left) - timelineTimestamp(right));

  return (
    <section
      aria-label="Pull request conversation"
      className="flex min-h-0 min-w-0 items-start justify-center overflow-auto bg-card px-5 py-6 max-[980px]:px-3"
    >
      {timeline.length === 0 ? (
        <p className="text-sm text-muted-foreground">No conversation yet.</p>
      ) : (
        <Timeline
          className="conversation-timeline w-full min-w-0 max-w-5xl"
          content={(item) => <ConversationItem item={item} />}
          marker={(item) => {
            const Icon = conversationIcon(item);
            return (
              <span
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full border-2 border-background",
                  conversationIconClass(item),
                )}
              >
                <Icon aria-hidden size={13} strokeWidth={2.5} />
              </span>
            );
          }}
          pt={{
            connector: { className: "conversation-timeline-connector" },
            content: { className: "conversation-timeline-content" },
            event: { className: "conversation-timeline-event" },
            opposite: { className: "conversation-timeline-opposite" },
            separator: { className: "conversation-timeline-separator" },
          }}
          unstyled
          value={timeline}
        />
      )}
    </section>
  );
}

function ConversationItem({ item }) {
  const label = conversationLabel(item);
  const isContent =
    ["comment", "description", "thread"].includes(item.kind) ||
    (item.kind === "review" && Boolean(item.body.trim()));
  return (
    <article
      className={cn(
        "relative min-w-0 text-sm",
        isContent ? "rounded-lg border bg-background p-4" : "flex items-center py-1.5",
      )}
    >
      <p
        className={cn(
          "min-w-0 font-semibold text-muted-foreground",
          isContent ? "text-xs" : "truncate",
        )}
      >
        {item.actor} {label}
      </p>
      {item.kind === "thread" ? <ConversationThread thread={item.thread} /> : null}
      {isContent && item.body ? <ConversationMarkdown body={item.body} /> : null}
    </article>
  );
}

function ConversationThread({ thread }) {
  return (
    <div className="mt-3 grid gap-3">
      <p className="font-mono text-xs text-muted-foreground">
        {thread.path}:{thread.line}
        {thread.isResolved ? " · resolved" : ""}
        {thread.isOutdated ? " · outdated" : ""}
      </p>
      {thread.comments.map((comment) => (
        <div className="border-t pt-3" key={comment.id || comment.createdAt}>
          <p className="text-xs font-semibold text-muted-foreground">{comment.actor}</p>
          <ConversationMarkdown body={comment.body} />
        </div>
      ))}
    </div>
  );
}

function ConversationMarkdown({ body }) {
  return (
    <div className="conversation-markdown mt-3 min-w-0 break-words leading-6">
      <ReactMarkdown
        components={{ table: MarkdownTable }}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, githubMarkdownSanitizeSchema]]}
        remarkPlugins={[remarkGfm, remarkAlert]}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownTable({ children }) {
  return (
    <div className="my-3 overflow-x-auto rounded-md border border-border">
      <table className="conversation-markdown-table">{children}</table>
    </div>
  );
}

function conversationLabel(item) {
  if (item.kind === "description") return "opened this pull request";
  if (item.kind === "review") return `submitted ${item.state.toLowerCase().replaceAll("_", " ")}`;
  if (item.kind === "thread") return "reviewed a file";
  if (item.kind === "commit") return `pushed ${item.body.split("\n", 1)[0] || "a commit"}`;
  if (item.type === "ReviewRequestedEvent")
    return `requested review from ${item.requestedReviewer || "a reviewer"}`;
  if (item.kind === "event")
    return String(item.type)
      .replace(/Event$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase();
  return "commented";
}

function conversationIcon(item) {
  if (item.kind === "description") return GitPullRequest;
  if (item.kind === "comment" || item.kind === "thread") return MessageSquare;
  if (item.kind === "review" && item.state === "APPROVED") return Check;
  if (item.kind === "review" && item.state === "COMMENTED") return MessageSquare;
  if (item.kind === "review") return FileText;
  if (item.kind === "commit") return GitCommitHorizontal;
  if (item.type === "ReviewRequestedEvent") return UserRoundPlus;
  if (item.type === "MergedEvent") return GitMerge;
  if (item.type === "ClosedEvent") return CircleX;
  if (item.type === "HeadRefForcePushedEvent") return RotateCcw;
  if (item.type === "CrossReferencedEvent") return GitPullRequestArrow;
  return CircleDot;
}

function conversationIconClass(item) {
  if (item.type === "MergedEvent") return "bg-pr-merged text-background";
  if (item.type === "ClosedEvent") return "bg-pr-closed text-background";
  if (item.kind === "description") return "bg-pr-open text-background";
  if (item.kind === "review" && item.state === "APPROVED") return "bg-pr-open text-background";
  if (
    item.kind === "comment" ||
    item.kind === "thread" ||
    (item.kind === "review" && item.state === "COMMENTED")
  )
    return "bg-background text-muted-foreground";
  if (item.kind === "review") return "bg-primary text-primary-foreground";
  return "bg-muted text-muted-foreground";
}

function timelineTimestamp(item) {
  if (item.kind === "description") return 0;
  const value = new Date(item.createdAt).getTime();
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}
