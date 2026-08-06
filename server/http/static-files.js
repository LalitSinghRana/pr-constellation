import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

const immutableAssetPrefix = "assets/";
const contentSecurityPolicy =
  "default-src 'self'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";

export async function serveStaticFiles({ request, response, root }) {
  if (!["GET", "HEAD"].includes(request.method)) return false;

  const resolvedRoot = path.resolve(root);
  const relativePath = resolveStaticRelativePath(request.url);
  if (!relativePath) return false;

  const filePath = path.resolve(resolvedRoot, relativePath);
  if (!isPathInsideRoot(filePath, resolvedRoot)) return false;

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) return false;

    const [realRoot, realFile] = await Promise.all([realpath(resolvedRoot), realpath(filePath)]);
    if (!isPathInsideRoot(realFile, realRoot)) return false;

    const body = request.method === "HEAD" ? undefined : await readFile(realFile);
    response.writeHead(200, staticResponseHeaders({ filePath, relativePath, size: fileStats.size }));
    response.end(body);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveStaticRelativePath(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  return pathname === "/" || !path.extname(pathname) ? "index.html" : pathname.slice(1);
}

function isPathInsideRoot(filePath, rootPath) {
  return filePath === rootPath || filePath.startsWith(`${rootPath}${path.sep}`);
}

function staticResponseHeaders({ filePath, relativePath, size }) {
  return {
    "Cache-Control": relativePath.startsWith(immutableAssetPrefix)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Content-Security-Policy": contentSecurityPolicy,
    "Content-Length": size,
    "Content-Type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
