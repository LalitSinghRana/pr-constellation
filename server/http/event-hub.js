const HEARTBEAT_INTERVAL_MS = 30_000;
const SSE_RETRY_MS = 3_000;

export function createEventHub({ maxClients = 20 } = {}) {
  if (!Number.isInteger(maxClients) || maxClients < 1) {
    throw new TypeError("maxClients must be a positive integer.");
  }
  const clients = new Set();
  const heartbeat = setInterval(() => {
    broadcast(clients, ": heartbeat\n\n");
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    handle(request, response) {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      if (clients.size >= maxClients) {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Too many event streams");
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      });
      response.write(`retry: ${SSE_RETRY_MS}\nevent: ready\ndata: {}\n\n`);
      clients.add(response);
      const remove = () => clients.delete(response);
      response.once("close", remove);
      response.once("error", remove);
    },

    publish(type, value = {}) {
      broadcast(clients, `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    },

    close() {
      clearInterval(heartbeat);
      for (const response of clients) response.end();
      clients.clear();
    },
  };
}

function broadcast(clients, event) {
  for (const response of clients) writeEvent(response, event, clients);
}

function writeEvent(response, event, clients) {
  if (response.destroyed || response.writableEnded) {
    clients.delete(response);
    return;
  }
  try {
    response.write(event);
  } catch {
    clients.delete(response);
    response.destroy();
  }
}
