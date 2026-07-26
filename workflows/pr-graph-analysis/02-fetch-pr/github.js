import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseGitHubPrUrl(prUrl) {
  let parsed;

  try {
    parsed = new URL(prUrl);
  } catch {
    throw new Error(`Expected a GitHub pull request URL, got: ${prUrl}`);
  }

  if (parsed.hostname !== "github.com") {
    throw new Error(`Expected a github.com URL, got: ${prUrl}`);
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const [owner, repo, pull, number] = parts;

  if (!owner || !repo || pull !== "pull" || !number || !/^\d+$/.test(number)) {
    throw new Error(`Expected a GitHub pull request URL, got: ${prUrl}`);
  }

  return {
    owner,
    repo,
    number,
    slug: `${repo}-${number}`,
  };
}

export async function fetchPullRequest(prUrl) {
  await ensureGhAccess();

  const metadata = await ghJson([
    "pr",
    "view",
    prUrl,
    "--json",
    [
      "additions",
      "author",
      "baseRefName",
      "body",
      "changedFiles",
      "commits",
      "deletions",
      "files",
      "headRefName",
      "number",
      "state",
      "title",
      "url",
    ].join(","),
  ]);

  const diff = await ghText(["pr", "diff", prUrl]);

  return {
    metadata,
    diff,
  };
}

async function ensureGhAccess() {
  try {
    await ghText(["--version"]);
  } catch {
    throw new Error("GitHub CLI is required. Install `gh`, then run `gh auth login`.");
  }

  try {
    await ghText(["auth", "status"]);
  } catch {
    throw new Error("GitHub CLI is not authenticated. Run `gh auth login`, then retry `prc`.");
  }
}

async function ghJson(args) {
  const text = await ghText(args);
  return JSON.parse(text);
}

async function ghText(args) {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 1024 * 1024 * 100,
    });
    return stdout;
  } catch (error) {
    const stderr = error?.stderr?.trim();
    const stdout = error?.stdout?.trim();
    const detail = stderr || stdout || error.message;
    throw new Error(`gh ${args.join(" ")} failed:\n${detail}`);
  }
}
