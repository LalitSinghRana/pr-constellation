import assert from "node:assert/strict";
import test from "node:test";
import { applySettingsPatch, resolveGitHubUsername } from "../inbox/inbox-service.js";

test("settings patches keep the stored GitHub username", () => {
  const current = applySettingsPatch(
    { username: "me", people: ["alice"], teams: ["example/platform"], autoQueue: true },
    { username: "other", people: ["bob"], teams: [], autoQueue: false },
  );
  assert.equal(current.username, "me");
  assert.deepEqual(current.people, ["bob"]);
  assert.deepEqual(current.teams, []);
  assert.equal(current.autoQueue, false);
});

test("only GitHub detection can replace the stored username", () => {
  const next = applySettingsPatch(
    { username: "me", people: [], teams: [] },
    { username: "other" },
    { usernameFromGitHub: "octocat" },
  );
  assert.equal(next.username, "octocat");
});

test("a blank stored username is detected and persisted", async () => {
  const saved = [];
  const username = await resolveGitHubUsername({
    detectUser: async () => "me",
    read: async () => ({ username: "" }),
    save: async (value, options) => {
      saved.push({ value, options });
    },
  });
  assert.equal(username, "me");
  assert.deepEqual(saved, [{ value: {}, options: { usernameFromGitHub: "me" } }]);
});

test("a stored username is reused without detecting GitHub", async () => {
  let detected = 0;
  const username = await resolveGitHubUsername({
    detectUser: async () => {
      detected += 1;
      return "other";
    },
    read: async () => ({ username: "me" }),
    save: async () => {
      throw new Error("settings should not be rewritten");
    },
  });
  assert.equal(username, "me");
  assert.equal(detected, 0);
});

test("scheduled sync reuses a stored username without detecting GitHub", async () => {
  let detected = 0;
  const username = await resolveGitHubUsername({
    detectUser: async () => {
      detected += 1;
      return "octocat";
    },
    read: async () => ({ username: "me" }),
    save: async () => {
      throw new Error("settings should not be rewritten");
    },
  });
  assert.equal(username, "me");
  assert.equal(detected, 0);
});

test("sync refresh overwrites a stored username when GitHub login changes", async () => {
  const saved = [];
  const username = await resolveGitHubUsername({
    detectUser: async () => "octocat",
    read: async () => ({ username: "me" }),
    refresh: true,
    save: async (value, options) => {
      saved.push({ value, options });
    },
  });
  assert.equal(username, "octocat");
  assert.deepEqual(saved, [{ value: {}, options: { usernameFromGitHub: "octocat" } }]);
});
