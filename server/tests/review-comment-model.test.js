import assert from "node:assert/strict";
import test from "node:test";
import {
  lineKey,
  lineTargetFromChunkLine,
  lineTargetFromGutter,
  resolveClickedLineTarget,
} from "../../client/src/review/review-comment-model.js";
import { parseGhTokenScopes } from "../review/github-review-client.js";

test("line targets map diff lines to GitHub file coordinates", () => {
  const chunk = { file: "src/app.js" };
  assert.deepEqual(lineTargetFromChunkLine({ newLine: 12, type: "add" }, chunk), {
    line: 12,
    path: "src/app.js",
    side: "RIGHT",
  });
  assert.deepEqual(lineTargetFromChunkLine({ oldLine: 8, type: "del" }, chunk), {
    line: 8,
    path: "src/app.js",
    side: "LEFT",
  });
});

test("gutter metadata resolves to GitHub line targets", () => {
  const gutter = {
    dataset: {
      reviewLine: "793",
      reviewPath: "server/inbox/inbox-service.js",
      reviewSide: "RIGHT",
    },
    textContent: "793",
  };
  const resolved = lineTargetFromGutter(gutter);
  assert.deepEqual(resolved, {
    line: 793,
    path: "server/inbox/inbox-service.js",
    side: "RIGHT",
  });
  assert.equal(lineKey(resolved), "server/inbox/inbox-service.js:RIGHT:793");
});

test("only gutter clicks resolve to GitHub line targets", () => {
  const gutter = {
    closest(selector) {
      if (String(selector).includes("data-line-new-num") || String(selector).includes("data-line-old-num")) {
        return this;
      }
      return null;
    },
    dataset: {
      reviewLine: "15",
      reviewPath: "src/app.js",
      reviewSide: "RIGHT",
    },
    textContent: "15",
  };
  const resolved = resolveClickedLineTarget(
    { file: "src/app.js" },
    {
      target: gutter,
    },
  );
  assert.deepEqual(resolved, { line: 15, path: "src/app.js", side: "RIGHT" });
  assert.equal(
    resolveClickedLineTarget({ file: "src/app.js" }, { target: { closest: () => null } }),
    null,
  );
});

test("gh token scopes are parsed from multi-scope status output", () => {
  const scopes = parseGhTokenScopes(`
github.com
  ✓ Logged in to github.com account example
  - Token scopes: 'admin:ssh_signing_key', 'gist', 'read:org', 'repo', 'user', 'workflow'
`);
  assert.deepEqual(scopes, [
    "admin:ssh_signing_key",
    "gist",
    "read:org",
    "repo",
    "user",
    "workflow",
  ]);
});
