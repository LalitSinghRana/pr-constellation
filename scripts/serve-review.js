#!/usr/bin/env node
import { createServer } from "node:http";
import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEWS_DIR = path.join(ROOT_DIR, ".reviews");
const REVIEW_ROUTE_PREFIX = "/reviews/";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;

const options = parseArgs(process.argv.slice(2));
const context = await resolveContext(options.target);
const server = createServer((request, response) => {
  void handleRequest({ request, response, context });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${options.port} is already in use. Reuse http://${options.host}:${options.port}/ or stop the existing server before restarting.`);
    process.exitCode = 1;
    return;
  }

  throw error;
});

listen({ server, context, host: options.host, port: options.port });

function listen({ server, context, host, port }) {
  server.listen(port, host, () => {
    const address = server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    const defaultUrl = context.defaultReview ? stableReviewUrlPath(context.defaultReview.slug) : "/";

    console.log(`Serving PR reviews from: ${REVIEWS_DIR}`);
    console.log(`Default review: ${context.defaultRootDir}`);
    console.log(`Open: http://${host}:${resolvedPort}${defaultUrl}`);
  });
}

async function handleRequest({ request, response, context }) {
  try {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const resolved = await resolveRequest({ context, requestUrl });

    if (resolved.redirect) {
      response.writeHead(302, {
        Location: resolved.redirect,
      });
      response.end();
      return;
    }

    if (!isPathInside(resolved.rootDir, resolved.filePath)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const stats = await stat(resolved.filePath);
    if (!stats.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType(resolved.filePath),
      "Content-Length": stats.size,
    });
    createReadStream(resolved.filePath).pipe(response);
  } catch (error) {
    if (error?.code === "ENOENT") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(500);
    response.end("Internal server error");
  }
}

async function resolveRequest({ context, requestUrl }) {
  const reviewSelector = requestUrl.searchParams.get("review") || requestUrl.searchParams.get("run");

  if (reviewSelector && requestUrl.pathname === "/") {
    const review = await resolveReviewSelector(reviewSelector);
    return { redirect: stableReviewUrlPath(review.slug) };
  }

  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === "/") {
    if (context.defaultReview) {
      return { redirect: stableReviewUrlPath(context.defaultReview.slug) };
    }

    return fileResponse({
      relativePath: "index.html",
      rootDir: context.defaultRootDir,
    });
  }

  if (pathname.startsWith(REVIEW_ROUTE_PREFIX)) {
    return await resolveReviewRoute(pathname);
  }

  return fileResponse({
    relativePath: pathname.slice(1),
    rootDir: context.defaultRootDir,
  });
}

async function resolveReviewRoute(pathname) {
  const routePath = pathname.slice(REVIEW_ROUTE_PREFIX.length);
  const rawSegments = routePath.split("/");
  const [slug, runId, ...assetSegments] = rawSegments;

  if (!slug) {
    return { redirect: "/" };
  }

  if (!runId) {
    const review = await resolveStableReview(slug);

    if (!pathname.endsWith("/")) {
      return { redirect: stableReviewUrlPath(review.slug) };
    }

    return fileResponse({
      relativePath: "index.html",
      rootDir: review.rootDir,
    });
  }

  const review = await resolveReview(slug, runId);

  if (assetSegments.length === 0 && !pathname.endsWith("/")) {
    return { redirect: reviewUrlPath(review) };
  }

  return fileResponse({
    relativePath: assetSegments.filter(Boolean).join("/") || "index.html",
    rootDir: review.rootDir,
  });
}

function fileResponse({ relativePath, rootDir }) {
  return {
    filePath: path.resolve(rootDir, relativePath),
    rootDir,
  };
}

async function resolveContext(targetArg) {
  if (targetArg) {
    const resolved = path.resolve(process.cwd(), targetArg);
    const targetStats = await stat(resolved);
    const rootDir = targetStats.isDirectory() ? resolved : path.dirname(resolved);
    const defaultReview = reviewFromRootDir(rootDir);

    await ensureIndex(rootDir);
    return {
      defaultReview,
      defaultRootDir: rootDir,
    };
  }

  const latestIndex = await findLatestIndex(REVIEWS_DIR);
  if (!latestIndex) {
    throw new Error("No generated review found under .reviews/. Run `pnpm prc -- view <run-dir>` first.");
  }

  const rootDir = path.dirname(latestIndex);

  return {
    defaultReview: reviewFromRootDir(rootDir),
    defaultRootDir: rootDir,
  };
}

async function ensureIndex(rootDir) {
  await stat(path.join(rootDir, "index.html"));
}

async function findLatestIndex(rootDir) {
  const candidates = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name === "index.html") {
        const stats = await stat(entryPath);
        candidates.push({ filePath: entryPath, mtimeMs: stats.mtimeMs });
      }
    }
  }

  await visit(rootDir);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath));
  return candidates[0]?.filePath || null;
}

async function resolveReviewSelector(selector) {
  const normalized = selector
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.reviews\//, "")
    .replace(/^reviews\//, "");
  const [slug, runId, ...extra] = normalized.split("/").filter(Boolean);

  if (!slug || extra.length > 0) {
    throw new Error(`Expected review selector in the form <repo-pr> or <repo-pr>/<run>, got: ${selector}`);
  }

  return runId ? await resolveReview(slug, runId) : await resolveStableReview(slug);
}

async function resolveStableReview(slug) {
  assertSafeRouteSegment(slug);

  const slugRootDir = path.resolve(REVIEWS_DIR, slug);
  if (!isPathInside(REVIEWS_DIR, slugRootDir)) {
    throw new Error("Review path escapes .reviews.");
  }

  const latestIndex = await findLatestIndex(slugRootDir);
  if (!latestIndex) {
    const error = new Error(`No generated review found for ${slug}.`);
    error.code = "ENOENT";
    throw error;
  }

  const review = reviewFromRootDir(path.dirname(latestIndex));
  if (!review || review.slug !== slug) {
    throw new Error(`Could not resolve latest review for ${slug}.`);
  }

  return review;
}

async function resolveReview(slug, runId) {
  assertSafeRouteSegment(slug);
  assertSafeRouteSegment(runId);

  const rootDir = path.resolve(REVIEWS_DIR, slug, runId);

  if (!isPathInside(REVIEWS_DIR, rootDir)) {
    throw new Error("Review path escapes .reviews.");
  }

  await ensureIndex(rootDir);

  return {
    rootDir,
    runId,
    slug,
  };
}

function reviewFromRootDir(rootDir) {
  const relativePath = path.relative(REVIEWS_DIR, rootDir);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  const [slug, runId, ...extra] = relativePath.split(path.sep);

  if (!slug || !runId || extra.length > 0) {
    return null;
  }

  return {
    rootDir,
    runId,
    slug,
  };
}

function reviewUrlPath(review) {
  return `${REVIEW_ROUTE_PREFIX}${encodeURIComponent(review.slug)}/${encodeURIComponent(review.runId)}/`;
}

function stableReviewUrlPath(slug) {
  return `${REVIEW_ROUTE_PREFIX}${encodeURIComponent(slug)}/`;
}

function assertSafeRouteSegment(segment) {
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
    throw new Error(`Invalid review route segment: ${segment}`);
  }
}

function isPathInside(rootDir, filePath) {
  const relativePath = path.relative(rootDir, filePath);

  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function parseArgs(args) {
  const options = {
    host: process.env.HOST || DEFAULT_HOST,
    port: Number(process.env.PORT || DEFAULT_PORT),
    target: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--host") {
      options.host = args[index + 1];
      index += 1;
    } else if (arg === "--port") {
      options.port = Number(args[index + 1]);
      index += 1;
    } else if (arg === "--latest") {
      options.target = undefined;
    } else if (!options.target) {
      options.target = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  return options;
}

function contentType(filePath) {
  const extension = path.extname(filePath);

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".png") {
    return "image/png";
  }

  return "application/octet-stream";
}
