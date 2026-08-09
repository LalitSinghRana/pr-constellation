import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { remarkAlert } from "remark-github-blockquote-alert";
import { githubMarkdownSanitizeSchema } from "../src/review/github-markdown.js";

test("GitHub Markdown renders GFM and safe GitHub HTML", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        rehypePlugins: [rehypeRaw, [rehypeSanitize, githubMarkdownSanitizeSchema]],
        remarkPlugins: [remarkGfm, remarkAlert],
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
