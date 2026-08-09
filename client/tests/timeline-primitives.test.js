import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { Timeline } = createRequire(import.meta.url)("primereact/timeline/timeline.cjs.js");

test("PrimeReact Timeline renders its event, marker, connector, and content", () => {
  const html = renderToStaticMarkup(
    React.createElement(Timeline, {
      content: () => "Comment",
      marker: () => "Icon",
      unstyled: true,
      value: [{ id: "comment-1" }, { id: "comment-2" }],
    }),
  );

  for (const section of ["event", "separator", "connector", "content"]) {
    assert.match(html, new RegExp(`data-pc-section="${section}"`));
  }
  assert.match(html, /Icon/);
  assert.match(html, /Comment/);
});
