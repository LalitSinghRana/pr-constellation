import { cockpitOrigin } from "../runtime-config.js";
import {
  addReviewDraftComment,
  deleteReviewDraftComment,
  getReviewDraftSnapshot,
  submitReviewDraft,
  updateReviewDraftBody,
  updateReviewDraftComment,
} from "./review-draft-service.js";

const reviewSlugPattern = /^\/api\/reviews\/([^/]+)\/draft(?:\/comments(?:\/([^/]+))?|\/submit)?$/;

export async function handleReviewDraftApiRequest(request, response) {
  const url = new URL(request.url, cockpitOrigin);
  const match = reviewSlugPattern.exec(url.pathname);
  if (!match) return false;

  const slug = decodeURIComponent(match[1]);
  const commentId = match[2] ? decodeURIComponent(match[2]) : null;
  const commentsPath = url.pathname.endsWith("/comments") || Boolean(commentId);
  const submitPath = url.pathname.endsWith("/submit");

  try {
    if (request.method === "GET" && url.pathname === `/api/reviews/${slug}/draft`) {
      sendJson(response, 200, await getReviewDraftSnapshot(slug));
      return true;
    }

    if (request.method === "PUT" && url.pathname === `/api/reviews/${slug}/draft`) {
      const body = await readRequestJson(request);
      sendJson(response, 200, await updateReviewDraftBody(slug, body.body));
      return true;
    }

    if (request.method === "POST" && submitPath) {
      const body = await readRequestJson(request);
      sendJson(
        response,
        200,
        await submitReviewDraft(slug, { body: body.body, event: body.event }),
      );
      return true;
    }

    if (commentsPath) {
      if (request.method === "POST" && !commentId) {
        const body = await readRequestJson(request);
        sendJson(
          response,
          201,
          await addReviewDraftComment(slug, {
            body: body.body,
            line: body.line,
            path: body.path,
            replyToCommentId: body.replyToCommentId,
            side: body.side,
          }),
        );
        return true;
      }

      if (request.method === "PUT" && commentId) {
        const body = await readRequestJson(request);
        sendJson(response, 200, await updateReviewDraftComment(slug, commentId, body.body));
        return true;
      }

      if (request.method === "DELETE" && commentId) {
        sendJson(response, 200, await deleteReviewDraftComment(slug, commentId));
        return true;
      }
    }
  } catch (error) {
    if (error.code === "HEAD_STALE") {
      sendJson(response, 409, { code: error.code, error: error.message });
      return true;
    }
    if (error.code === "AUTH") {
      sendJson(response, 403, { code: error.code, error: error.message });
      return true;
    }
    if (error.code === "GITHUB_API") {
      sendJson(response, 502, { code: error.code, error: error.message });
      return true;
    }
    sendJson(response, 400, { error: error.message });
    return true;
  }

  response.writeHead(405, { Allow: "GET, PUT, POST, DELETE" });
  response.end();
  return true;
}

async function readRequestJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error("Request too large");
  }
  return JSON.parse(body || "{}");
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
