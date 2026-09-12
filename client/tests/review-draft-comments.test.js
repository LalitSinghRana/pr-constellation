import assert from "node:assert/strict";
import test from "node:test";
import { saveDraftComment } from "../src/lib/review-draft-api.js";

const reviewSlug = "gh-4-acme-3-app-42";
const pendingTarget = { line: 18, path: "src/app.js", side: "RIGHT" };

test("saveDraftComment POSTs a new line comment", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ options, url: String(url) });
    return {
      json: async () => ({ comments: [] }),
      ok: true,
    };
  };

  try {
    await saveDraftComment({
      composerBody: "First note",
      pendingTarget,
      reviewSlug,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "POST");
    assert.match(calls[0].url, /\/draft\/comments$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      body: "First note",
      line: 18,
      path: "src/app.js",
      side: "RIGHT",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("saveDraftComment PUTs when a draft already exists on the line", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ options, url: String(url) });
    return {
      json: async () => ({ comments: [{ body: "Updated note", id: "comment-1" }] }),
      ok: true,
    };
  };

  try {
    await saveDraftComment({
      composerBody: "Updated note",
      existing: { id: "comment-1" },
      pendingTarget,
      reviewSlug,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "PUT");
    assert.match(calls[0].url, /\/draft\/comments\/comment-1$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), { body: "Updated note" });
  } finally {
    global.fetch = originalFetch;
  }
});
