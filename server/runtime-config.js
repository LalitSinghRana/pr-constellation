import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultPort = 4397;
export const host = "127.0.0.1";
export const port = parsePort(process.env.PORT);
export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const clientRoot = path.join(projectRoot, "client");
export const clientDistRoot = path.join(clientRoot, "dist");
export const reviewsDir = path.join(projectRoot, ".reviews");
export const databaseDir = path.join(projectRoot, "database");
export const settingsPath = path.join(databaseDir, "settings.json");
export const queuePath = path.join(databaseDir, "queue.json");
export const databasePath = path.join(databaseDir, "cockpit.sqlite3");
export const cockpitOrigin = `http://${host}:${port}`;

function parsePort(value) {
  if (value == null || value === "") return defaultPort;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}
