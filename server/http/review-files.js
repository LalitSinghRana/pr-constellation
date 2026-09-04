import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { cockpitOrigin, reviewsDir } from "../runtime-config.js";

/** Document URLs owned by the SPA (not static HTML artifacts). */
export function isReviewSpaDocumentPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "reviews" || parts.length < 2 || parts.length > 3) {
    return false;
  }
  if (parts.some((segment) => segment.startsWith(".") || segment.includes("\\"))) {
    return false;
  }
  // Artifact files under a run (analysis.json, diff.patch, …) have an extension.
  if (parts.length === 3 && path.extname(parts[2])) {
    return false;
  }
  return true;
}

export function reviewArtifactPath(pathname) {
  if (!/^\/reviews\/[^/]/.test(pathname)) return null;
  if (isReviewSpaDocumentPath(pathname)) return null;
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice("/reviews/".length));
  } catch {
    return null;
  }
  if (relativePath.split("/").some((segment) => segment.startsWith("."))) return null;
  const filePath = path.resolve(reviewsDir, relativePath);
  return filePath.startsWith(`${reviewsDir}${path.sep}`) ? filePath : null;
}

export async function serveReviewArtifact(request, response) {
  const pathname = new URL(request.url, cockpitOrigin).pathname;
  if (isReviewSpaDocumentPath(pathname)) return false;

  const filePath = reviewArtifactPath(pathname);
  if (!filePath) return false;
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return true;
  }

  try {
    if ((await stat(filePath)).isDirectory()) {
      // Review document directories are SPA-owned; do not serve index.html.
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Review not found");
      return true;
    }
    if (path.extname(filePath) === ".html") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Review not found");
      return true;
    }
    const [realReviewsDir, realFile] = await Promise.all([
      realpath(reviewsDir),
      realpath(filePath),
    ]);
    if (realFile !== realReviewsDir && !realFile.startsWith(`${realReviewsDir}${path.sep}`)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Review not found");
      return true;
    }
    const fileStats = await stat(realFile);
    const body = request.method === "HEAD" ? undefined : await readFile(realFile);
    const contentType =
      {
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
      }[path.extname(realFile)] ?? "application/octet-stream";
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": fileStats.size,
      "Content-Type": contentType,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end(error.code === "ENOENT" ? "Review not found" : "Review could not be loaded");
  }
  return true;
}
