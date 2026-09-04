import { cockpitOrigin } from "../runtime-config.js";
import {
  getLatestReviewPayload,
  getReviewContext,
  getReviewPayloadForRun,
} from "./review-payload-service.js";

const latestReviewPattern = /^\/api\/reviews\/([^/]+)\/?$/;
const reviewContextPattern = /^\/api\/reviews\/([^/]+)\/context\/?$/;
const runReviewPattern = /^\/api\/reviews\/([^/]+)\/runs\/([^/]+)\/?$/;

export async function handleReviewPayloadApiRequest(request, response, { store }) {
  const url = new URL(request.url, cockpitOrigin);
  const runMatch = runReviewPattern.exec(url.pathname);
  const contextMatch = reviewContextPattern.exec(url.pathname);
  const latestMatch = runMatch || contextMatch ? null : latestReviewPattern.exec(url.pathname);
  if (!runMatch && !latestMatch && !contextMatch) return false;

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return true;
  }

  try {
    const slug = decodeURIComponent((runMatch || latestMatch || contextMatch)[1]);
    const payload = contextMatch
      ? await getReviewContext(store, slug)
      : runMatch
        ? await getReviewPayloadForRun(store, slug, decodeURIComponent(runMatch[2]))
        : await getLatestReviewPayload(store, slug);
    const body = JSON.stringify(payload);
    response.writeHead(200, secureHeaders("application/json; charset=utf-8"));
    if (request.method !== "HEAD") {
      response.end(body);
    } else {
      response.end();
    }
  } catch (error) {
    if (error?.code === "REVIEW_NOT_FOUND" || error?.code === "INVALID_STORAGE_ID") {
      sendJson(response, 404, { error: error.message });
      return true;
    }
    sendJson(response, 500, { error: "Review could not be loaded" });
  }
  return true;
}

function sendJson(response, status, value) {
  response.writeHead(status, secureHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

function secureHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
}
