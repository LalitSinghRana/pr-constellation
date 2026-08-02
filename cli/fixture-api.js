export function createFixtureApiMiddleware({ service }) {
  if (!service) {
    throw new TypeError("service is required.");
  }

  return async function fixtureApiMiddleware(request, response, next) {
    const url = new URL(request.url || "/", "http://127.0.0.1");

    if (!url.pathname.startsWith("/api/fixtures")) {
      next?.();
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/fixtures") {
        sendJson(response, 200, { fixtures: await service.listFixtures() });
        return;
      }

      const runMatch = url.pathname.match(/^\/api\/fixtures\/([^/]+)\/run\/?$/);
      if (request.method === "POST" && runMatch) {
        const key = decodePathPart(runMatch[1]);
        const run = await service.triggerRun(key);
        sendJson(response, 202, { run });
        return;
      }

      const stopMatch = url.pathname.match(/^\/api\/fixtures\/([^/]+)\/stop\/?$/);
      if (request.method === "POST" && stopMatch) {
        const key = decodePathPart(stopMatch[1]);
        const stopped = await service.stopRun(key);
        sendJson(response, 200, { stopped });
        return;
      }

      sendJson(response, 404, { error: "Fixture API route not found." });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new Error("Fixture path contains invalid URL encoding.");
    error.statusCode = 400;
    throw error;
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
