import { cockpitOrigin, port } from "../../runtime-config.js";

const runtimeUrl = new URL(cockpitOrigin);
const localhostOrigin = port === 80 ? "http://localhost" : `http://localhost:${port}`;
const allowedOrigins = new Set([runtimeUrl.origin, localhostOrigin]);
const allowedHosts = new Set([runtimeUrl.host, new URL(localhostOrigin).host]);

export function secureHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

export function sendJson(response, status, value) {
  response.writeHead(status, secureHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

export function requestHostRejection(request) {
  if (allowedHosts.has(String(request.headers.host ?? "").toLowerCase())) return null;
  return { status: 421, error: "This server accepts only local PR Constellation hostnames." };
}

export function apiMutationRejection(request, pathname) {
  if (
    !pathname.startsWith("/api/") ||
    !["DELETE", "PATCH", "POST", "PUT"].includes(request.method)
  ) {
    return null;
  }
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if ((origin && !allowedOrigins.has(origin)) || fetchSite === "cross-site") {
    return { status: 403, error: "Cross-origin API mutations are not allowed." };
  }
  if (
    ["PATCH", "POST", "PUT"].includes(request.method) &&
    !String(request.headers["content-type"] ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    return { status: 415, error: "Expected an application/json request." };
  }
  return null;
}
