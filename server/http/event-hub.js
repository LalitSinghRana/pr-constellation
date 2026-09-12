export function createEventHub({ maxClients = 20 } = {}) {
  if (!Number.isInteger(maxClients) || maxClients < 1) {
    throw new TypeError("maxClients must be a positive integer.");
  }
  const clients = new Set();
  const heartbeat = setInterval(() => {
    for (const response of clients) writeEvent(response, ": heartbeat\n\n", clients);
  }, 30_000);
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
      response.write("retry: 3000\nevent: ready\ndata: {}\n\n");
      clients.add(response);
      const remove = () => clients.delete(response);
      response.once("close", remove);
      response.once("error", remove);
    },

    publish(type, value = {}) {
      const event = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
      for (const response of clients) writeEvent(response, event, clients);
    },

    close() {
      clearInterval(heartbeat);
      for (const response of clients) response.end();
      clients.clear();
    },
  };
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
