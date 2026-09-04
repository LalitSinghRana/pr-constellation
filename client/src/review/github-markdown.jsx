import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "../lib/utils.js";
import {
  githubMarkdownRehypePlugins,
  githubMarkdownRemarkPlugins,
  guessMediaKind,
  proxiedMediaUrl,
  shouldRenderAsMedia,
} from "./github-markdown.js";

const markdownComponents = {
  a: MarkdownAnchor,
  img: MarkdownImage,
  video: MarkdownVideo,
};

export function GitHubMarkdown({ body, className }) {
  const text = String(body || "");
  if (!text.trim()) {
    return null;
  }

  return (
    <div
      className={cn(
        "github-markdown prose prose-sm max-w-none text-foreground",
        "[--tw-prose-body:var(--foreground)] [--tw-prose-bold:var(--foreground)] [--tw-prose-bullets:var(--muted-foreground)] [--tw-prose-captions:var(--muted-foreground)] [--tw-prose-code:var(--foreground)] [--tw-prose-counters:var(--muted-foreground)] [--tw-prose-headings:var(--foreground)] [--tw-prose-hr:var(--border)] [--tw-prose-invert-body:var(--foreground)] [--tw-prose-invert-headings:var(--foreground)] [--tw-prose-invert-links:var(--primary)] [--tw-prose-kbd:var(--foreground)] [--tw-prose-kbd-shadows:var(--border)] [--tw-prose-lead:var(--muted-foreground)] [--tw-prose-links:var(--primary)] [--tw-prose-pre-bg:var(--muted)] [--tw-prose-pre-code:var(--foreground)] [--tw-prose-quote-borders:var(--border)] [--tw-prose-quotes:var(--muted-foreground)] [--tw-prose-td-borders:var(--border)] [--tw-prose-th-borders:var(--border)]",
        "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        components={markdownComponents}
        rehypePlugins={githubMarkdownRehypePlugins}
        remarkPlugins={githubMarkdownRemarkPlugins}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownAnchor({ children, href, ...props }) {
  if (shouldRenderAsMedia(href)) {
    return <GitHubMedia alt={plainTextChildren(children)} src={href} />;
  }

  return (
    <a href={href} rel="noreferrer" target="_blank" {...props}>
      {children}
    </a>
  );
}

function MarkdownImage({ alt = "", src }) {
  return <GitHubMedia alt={alt} src={src} />;
}

function MarkdownVideo({ src, ...props }) {
  return <GitHubMedia alt="" src={src} {...props} />;
}

function GitHubMedia({ alt, src }) {
  const [kind, setKind] = useState(() => guessMediaKind(src));
  const mediaSrc = proxiedMediaUrl(src);
  const label = alt || src;

  if (kind === "link") {
    return (
      <a href={src} rel="noreferrer" target="_blank">
        {label}
      </a>
    );
  }

  if (kind === "video") {
    return (
      <video
        className="max-h-[min(24rem,70vh)] w-full max-w-full"
        controls
        onError={() => setKind("link")}
        playsInline
        src={mediaSrc}
      >
        <track kind="captions" />
        <a href={src} rel="noreferrer" target="_blank">
          {label}
        </a>
      </video>
    );
  }

  return (
    <img
      alt={alt || ""}
      className="max-h-[min(24rem,70vh)] w-auto max-w-full"
      onError={() => setKind("video")}
      src={mediaSrc}
    />
  );
}

function plainTextChildren(children) {
  return String(children ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
