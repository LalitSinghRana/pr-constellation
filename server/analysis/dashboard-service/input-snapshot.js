import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readCodeVersion({ cwd = process.cwd() } = {}) {
  try {
    const [{ stdout: commitOutput }, { stdout: diffOutput }, { stdout: untrackedOutput }] =
      await Promise.all([
        execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
        execFileAsync("git", ["diff", "--binary", "HEAD"], {
          cwd,
          maxBuffer: 1024 * 1024 * 100,
        }),
        execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
          cwd,
          encoding: "buffer",
          maxBuffer: 1024 * 1024 * 20,
        }),
      ]);
    const commit = commitOutput.trim();
    const hash = createHash("sha256");
    hash.update(diffOutput);
    const untrackedFiles = Buffer.from(untrackedOutput)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();

    for (const relativeFile of untrackedFiles) {
      hash.update(relativeFile);
      hash.update(await readFile(path.join(cwd, relativeFile)));
    }

    const dirty = diffOutput.length > 0 || untrackedFiles.length > 0;
    const dirtyHash = hash.digest("hex").slice(0, 12);
    return {
      commit,
      dirty,
      fingerprint: dirty ? `${commit.slice(0, 12)}-dirty-${dirtyHash}` : commit,
    };
  } catch {
    return { commit: null, dirty: null, fingerprint: "unknown" };
  }
}

export function createInputFingerprint({ diff, metadata }) {
  if (typeof diff !== "string") throw new TypeError("PR input diff must be a string.");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("PR input metadata must be an object.");
  }

  const hash = createHash("sha256");
  hash.update("pr-input-snapshot/v1\0");
  hash.update(JSON.stringify(sortJsonValue(metadata)));
  hash.update("\0");
  hash.update(diff);
  return hash.digest("hex");
}

export async function resolveFrozenInputFingerprint(frozenSource) {
  const stored = frozenSource.run?.metrics?.inputFingerprint;
  if (typeof stored === "string" && stored.length > 0) return stored;
  const [metadataText, diff] = await Promise.all([
    readFile(frozenSource.metadataPath, "utf8"),
    readFile(frozenSource.diffPath, "utf8"),
  ]);
  return createInputFingerprint({ diff, metadata: JSON.parse(metadataText) });
}

export async function readInputFingerprint(runDir) {
  const [metadataText, diff] = await Promise.all([
    readFile(path.join(runDir, "metadata.json"), "utf8"),
    readFile(path.join(runDir, "diff.patch"), "utf8"),
  ]);
  return createInputFingerprint({ diff, metadata: JSON.parse(metadataText) });
}

export async function tryReadInputFingerprint(runDir) {
  try {
    return await readInputFingerprint(runDir);
  } catch {
    return null;
  }
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}
