import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cockpitOrigin } from "../runtime-config.js";

const exec = promisify(execFile);
const githubMediaHostPattern = /^(?:[a-z0-9-]+\.)*(?:github(?:usercontent)?\.com)$/i;
const githubAssetS3HostPattern =
  /^github-(?:cloud|production-(?:user-asset|repository-(?:file|image)|release-asset|upload-manifest)-[a-z0-9]+)\.s3\.amazonaws\.com$/i;
const maxRedirects = 5;
const maxBytes = 100 * 1024 * 1024;

export function isAllowedGitHubMediaUrl(value) {
  return isHttpsHostMatch(value, githubMediaHostPattern);
}

export function isAllowedGitHubMediaRedirectUrl(value) {
  return isAllowedGitHubMediaUrl(value) || isHttpsHostMatch(value, githubAssetS3HostPattern);
}

export async function handleGitHubMediaRequest(
  request,
  response,
  { fetchImpl = fetch, getToken = defaultGetToken } = {},
) {
  const url = new URL(request.url, cockpitOrigin);
  if (url.pathname !== "/api/github-media") {
    return false;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET", "X-Content-Type-Options": "nosniff" });
    response.end();
    return true;
  }

  const target = url.searchParams.get("url");
  if (!isAllowedGitHubMediaUrl(target)) {
    response.writeHead(400, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify({ error: "Unsupported media URL." }));
    return true;
  }

  try {
    const token = await getToken();
    const upstream = await fetchGitHubMedia(target, { fetchImpl, token });
    if (!upstream.ok) {
      response.writeHead(upstream.status >= 400 ? upstream.status : 502, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end("GitHub media could not be loaded.");
      return true;
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const contentLength = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      response.writeHead(413, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end("GitHub media is too large.");
      return true;
    }

    if (!upstream.body) {
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.byteLength > maxBytes) {
        response.writeHead(413, {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        response.end("GitHub media is too large.");
        return true;
      }
      response.writeHead(200, {
        "Cache-Control": "private, max-age=300",
        "Content-Length": body.byteLength,
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
      return true;
    }

    const headers = {
      "Cache-Control": "private, max-age=300",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    };
    if (Number.isFinite(contentLength) && contentLength > 0) {
      headers["Content-Length"] = contentLength;
    }
    response.writeHead(200, headers);
    let written = 0;
    for await (const chunk of upstream.body) {
      written += chunk.byteLength;
      if (written > maxBytes) {
        response.destroy();
        return true;
      }
      response.write(chunk);
    }
    response.end();
    return true;
  } catch {
    response.writeHead(502, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end("GitHub media could not be loaded.");
    return true;
  }
}

async function fetchGitHubMedia(target, { fetchImpl, token }) {
  let current = target;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (hop > 0 && !isAllowedGitHubMediaRedirectUrl(current)) {
      return {
        ok: false,
        status: 400,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const headers = {
      Accept: "*/*",
      "User-Agent": "pr-constellation",
    };
    if (isAllowedGitHubMediaUrl(current) && token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(current, {
      headers,
      method: "GET",
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      current = new URL(response.headers.get("location") || "", current).href;
      continue;
    }
    return response;
  }
  return {
    ok: false,
    status: 502,
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function isHttpsHostMatch(value, hostPattern) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && hostPattern.test(url.hostname);
  } catch {
    return false;
  }
}

function defaultGetToken() {
  return exec("gh", ["auth", "token"], {
    encoding: "utf8",
    timeout: 15_000,
  }).then(({ stdout }) => stdout.trim());
}
