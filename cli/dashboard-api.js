const MAX_REQUEST_BYTES = 64 * 1024;

export function createDashboardApiMiddleware({ service }) {
  if (!service) {
    throw new TypeError("service is required.");
  }

  return async function dashboardApiMiddleware(request, response, next) {
    const url = new URL(request.url || "/", "http://127.0.0.1");

    if (!url.pathname.startsWith("/api/")) {
      next?.();
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        sendJson(response, 200, await service.snapshot());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = await readJsonBody(request);
        if (typeof body.prUrl !== "string" || body.prUrl.trim() === "") {
          throw createHttpError(400, "prUrl is required.");
        }
        validateOptionalModel(body.model);
        const run = await service.enqueue({
          model: body.model?.trim(),
          prUrl: body.prUrl.trim(),
          refresh: body.refresh === true,
        });
        sendJson(response, 202, { run, runs: [run] });
        return;
      }

      const cancelBatchMatch = url.pathname.match(
        /^\/api\/batches\/([^/]+)\/cancel\/?$/,
      );
      if (request.method === "POST" && cancelBatchMatch) {
        const batchId = decodePathPart(cancelBatchMatch[1]);
        const cancellation = await service.cancelBatch({ batchId });
        sendJson(response, 200, { cancellation });
        return;
      }

      const rerunBatchMatch = url.pathname.match(
        /^\/api\/batches\/([^/]+)\/rerun\/?$/,
      );
      if (request.method === "POST" && rerunBatchMatch) {
        const batchId = decodePathPart(rerunBatchMatch[1]);
        const body = await readOptionalJsonBody(request);
        validateOptionalModel(body.model);
        const run = await service.enqueueFrozenBatchRerun({
          batchId,
          model: body.model?.trim(),
        });
        sendJson(response, 202, { run, runs: [run] });
        return;
      }

      const cancelRunMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/([^/]+)\/cancel\/?$/,
      );
      if (request.method === "POST" && cancelRunMatch) {
        const slug = decodePathPart(cancelRunMatch[1]);
        const runId = decodePathPart(cancelRunMatch[2]);
        const cancellation = await service.cancelRun({ runId, slug });
        sendJson(response, 200, { cancellation });
        return;
      }

      const rerunMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/([^/]+)\/rerun\/?$/,
      );
      if (request.method === "POST" && rerunMatch) {
        const slug = decodePathPart(rerunMatch[1]);
        const runId = decodePathPart(rerunMatch[2]);
        const body = await readOptionalJsonBody(request);
        validateOptionalModel(body.model);
        const run = await service.enqueueFrozenRerun({
          model: body.model?.trim(),
          runId,
          slug,
        });
        sendJson(response, 202, { run, runs: [run] });
        return;
      }

      const deleteBatchMatch = url.pathname.match(
        /^\/api\/batches\/([^/]+)\/?$/,
      );
      if (request.method === "DELETE" && deleteBatchMatch) {
        const batchId = decodePathPart(deleteBatchMatch[1]);
        const deletion = await service.deleteBatchHistory({ batchId });
        sendJson(response, 200, { deletion });
        return;
      }

      const deleteRunMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/([^/]+)\/?$/,
      );
      if (request.method === "DELETE" && deleteRunMatch) {
        const slug = decodePathPart(deleteRunMatch[1]);
        const runId = decodePathPart(deleteRunMatch[2]);
        const deletion = await service.deleteRunHistory({ runId, slug });
        sendJson(response, 200, { deletion });
        return;
      }

      sendJson(response, 404, {
        error: "Dashboard API route not found.",
      });
    } catch (error) {
      const status = httpStatusForError(error);
      sendJson(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

async function readJsonBody(request) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw createHttpError(415, "Expected an application/json request body.");
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw createHttpError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw createHttpError(400, "Request body must contain valid JSON.");
  }
}

async function readOptionalJsonBody(request) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (!request.headers["transfer-encoding"] && contentLength === 0) {
    return {};
  }
  return readJsonBody(request);
}

function validateOptionalModel(model) {
  if (
    model != null
    && (typeof model !== "string" || model.trim() === "")
  ) {
    throw createHttpError(400, "model must be a non-empty string.");
  }
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw createHttpError(400, "Run path contains invalid URL encoding.");
  }
}

function sendJson(response, status, value) {
  if (response.writableEnded) {
    return;
  }
  const body = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function httpStatusForError(error) {
  if (Number.isInteger(error?.statusCode)) {
    return error.statusCode;
  }
  if (error?.code === "ENOENT" || error?.code === "SOURCE_INPUT_MISSING") {
    return 404;
  }
  if (error?.code === "CANCEL_TARGET_NOT_FOUND") {
    return 404;
  }
  if (error?.code === "HISTORY_TARGET_NOT_FOUND") {
    return 404;
  }
  if (error?.code === "HISTORY_TARGET_ACTIVE") {
    return 409;
  }
  if (error?.code === "RUN_ALREADY_EXISTS") {
    return 409;
  }
  if (
    error?.code === "INVALID_STORAGE_ID"
    || error?.code === "INVALID_MODEL"
    || error?.code === "INVALID_REASONING_EFFORT"
    || error?.code === "INVALID_SOURCE_INPUT"
    || error?.code === "INVALID_SOURCE_RUN"
    || error instanceof TypeError
    || /Expected a GitHub pull request URL/.test(error?.message || "")
  ) {
    return 400;
  }
  return 500;
}
