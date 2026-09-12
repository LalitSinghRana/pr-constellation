import assert from "node:assert/strict";
import test from "node:test";
import {
  createReviewSlug,
  parseGitHubPrUrl,
  parseReviewSlug,
} from "../../analysis-worker/workflow/02-fetch-pr/github.js";

test("review slugs round-trip owner, repo, and number", () => {
  const parsed = parseGitHubPrUrl("https://github.com/acme/widgets/pull/42");
  assert.equal(parsed.slug, "gh-4-acme-7-widgets-42");
  assert.deepEqual(parseReviewSlug(parsed.slug), {
    number: "42",
    owner: "acme",
    repo: "widgets",
    slug: parsed.slug,
  });
  assert.equal(
    createReviewSlug({ owner: "Example", repo: "App", number: "12" }),
    "gh-7-example-3-app-12",
  );
});
