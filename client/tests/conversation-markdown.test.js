import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import {
  githubMarkdownRehypePlugins,
  githubMarkdownRemarkPlugins,
  guessMediaKind,
  isGitHubAttachmentUrl,
  proxiedMediaUrl,
  shouldRenderAsMedia,
} from "../src/review/github-markdown.js";

test("GitHub Markdown renders GFM and safe GitHub HTML", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        rehypePlugins: githubMarkdownRehypePlugins,
        remarkPlugins: githubMarkdownRemarkPlugins,
      },
      `| Check | Status |
| --- | --- |
| Link | https://github.com |

# Heading

1. First

- [x] Done

> [!IMPORTANT]
> Keep this visible.

<details><summary>More</summary>One<br />two<script>unsafe()</script></details>`,
    ),
  );

  assert.match(html, /<table>/);
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /href="https:\/\/github\.com"/);
  assert.match(html, /<ol>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /markdown-alert-important/);
  assert.match(html, /<details><summary>More<\/summary>One<br\/>two<\/details>/);
  assert.doesNotMatch(html, /\[!IMPORTANT\]/);
  assert.doesNotMatch(html, /unsafe/);
});

test("GitHub Markdown allows video tags and strips scripts", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        rehypePlugins: githubMarkdownRehypePlugins,
        remarkPlugins: githubMarkdownRemarkPlugins,
      },
      '<video src="https://example.com/demo.mp4"></video><script>unsafe()</script>',
    ),
  );

  assert.match(html, /<video /);
  assert.doesNotMatch(html, /unsafe/);
});

test("GitHub media URL helpers classify attachments and proxy GitHub hosts", () => {
  const attachment =
    "https://github.com/user-attachments/assets/18fdb2d9-8a16-477d-8793-8540f12fac76";
  assert.equal(isGitHubAttachmentUrl(attachment), true);
  assert.equal(shouldRenderAsMedia(attachment), true);
  assert.equal(guessMediaKind(attachment), "image");
  assert.equal(guessMediaKind("https://example.com/clip.mp4"), "video");
  assert.equal(
    proxiedMediaUrl(attachment),
    `/api/github-media?url=${encodeURIComponent(attachment)}`,
  );
  assert.equal(
    proxiedMediaUrl("https://storage.googleapis.com/demo.png"),
    "https://storage.googleapis.com/demo.png",
  );
});
