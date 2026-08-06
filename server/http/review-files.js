import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { cockpitOrigin, reviewsDir } from "../runtime-config.js";

const reviewContentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
});

export function reviewArtifactPath(pathname) {
  if (!/^\/reviews\/[^/]/.test(pathname)) return null;
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
  let filePath = reviewArtifactPath(pathname);
  if (!filePath) return false;
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return true;
  }

  try {
    const resolvedPath = await resolveReviewFilePath(filePath);
    const fileStats = await stat(resolvedPath);
    const body = request.method === "HEAD" ? undefined : await readFile(resolvedPath);
    response.writeHead(200, reviewArtifactHeaders(resolvedPath, fileStats.size));
    response.end(body);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end(error.code === "ENOENT" ? "Review not found" : "Review could not be loaded");
  }
  return true;
}

async function resolveReviewFilePath(filePath) {
  let candidate = filePath;
  if ((await stat(candidate)).isDirectory()) {
    candidate = path.join(candidate, "index.html");
  }

  const [realReviewsDir, realFile] = await Promise.all([realpath(reviewsDir), realpath(candidate)]);
  if (realFile !== realReviewsDir && !realFile.startsWith(`${realReviewsDir}${path.sep}`)) {
    const error = new Error("Review not found");
    error.code = "ENOENT";
    throw error;
  }
  return realFile;
}

function reviewArtifactHeaders(filePath, size) {
  return {
    "Cache-Control": "no-store",
    "Content-Length": size,
    "Content-Type": reviewContentTypes[path.extname(filePath)] ?? "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
