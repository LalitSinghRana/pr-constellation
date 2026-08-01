import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const label = "com.lalitrana.pr-review-cockpit.sync";
const home = homedir();
const installDirectory = join(home, ".local", "share", "pr-review-cockpit");
const installedServer = join(installDirectory, "server.mjs");
const launchAgents = join(home, "Library", "LaunchAgents");
const plistPath = join(launchAgents, `${label}.plist`);
const logDirectory = join(home, ".config", "pr-review-cockpit");
const sourceServer = fileURLToPath(new URL("../server.mjs", import.meta.url));
const domain = `gui/${process.getuid()}`;

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const { stdout } = await exec("/usr/bin/which", ["gh"]);
const path = [
  dirname(process.execPath),
  dirname(stdout.trim()),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

await mkdir(installDirectory, { recursive: true });
await mkdir(launchAgents, { recursive: true });
await mkdir(logDirectory, { recursive: true });
await copyFile(sourceServer, installedServer);
await chmod(installedServer, 0o700);
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
    <string>${xml(installedServer)}</string>
    <string>--sync</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(installDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(home)}</string>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(join(logDirectory, "sync.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDirectory, "sync.error.log"))}</string>
</dict>
</plist>
`,
  { mode: 0o644 },
);

await exec("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
await exec("/bin/launchctl", ["bootstrap", domain, plistPath]);
console.log(`Installed hourly sync: ${plistPath}`);
