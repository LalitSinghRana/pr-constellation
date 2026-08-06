import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const label = "com.lalitrana.pr-review-cockpit";
const legacyLabel = `${label}.sync`;
const home = homedir();
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const launchAgents = join(home, "Library", "LaunchAgents");
const plistPath = join(launchAgents, `${label}.plist`);
const legacyPlistPath = join(launchAgents, `${legacyLabel}.plist`);
const logDirectory = join(home, ".config", "pr-review-cockpit");
const domain = `gui/${process.getuid()}`;
const port = 4397;

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const { stdout } = await exec("/usr/bin/which", ["gh"]);
const executablePath = [
  dirname(process.execPath),
  dirname(stdout.trim()),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

await Promise.all([
  mkdir(launchAgents, { recursive: true }),
  mkdir(logDirectory, { recursive: true, mode: 0o700 }),
]);
await writeFile(
  plistPath,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(serverPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(home)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${xml(executablePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logDirectory, "server.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDirectory, "server.error.log"))}</string>
</dict>
</plist>
`,
  { mode: 0o644 },
);

await exec("/bin/launchctl", ["bootout", `${domain}/${legacyLabel}`]).catch(() => {});
await exec("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
await assertPortAvailable();
await exec("/bin/launchctl", ["bootstrap", domain, plistPath]);
await rm(legacyPlistPath, { force: true });
console.log(`Installed PR Review Cockpit service: ${plistPath}`);

async function assertPortAvailable() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => {
      probe.removeAllListeners("error");
      probe.close(resolve);
    });
  }).catch((error) => {
    throw new Error(`Port ${port} is already in use; stop that process and rerun the installer.`, {
      cause: error,
    });
  });
}
