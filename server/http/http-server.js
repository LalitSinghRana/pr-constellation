import { mkdir } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import {
  closeInboxStore,
  handleApiRequest,
  rejectUntrustedApiMutation,
  rejectUntrustedRequestHost,
  syncNotifications,
  syncQueue,
} from "../inbox/inbox-service.js";
import { createSyncScheduler } from "../inbox/sync-scheduler.js";
import { handleReviewDraftApiRequest } from "../review/review-draft-api.js";
import {
  clientDistRoot,
  clientRoot,
  cockpitOrigin,
  host,
  port,
  projectRoot,
  reviewsDir,
} from "../runtime-config.js";
import { createEventHub } from "./event-hub.js";
import { serveReviewArtifact } from "./review-files.js";
import { serveStaticFiles } from "./static-files.js";

async function assertServerPortAvailable() {
  const probe = createHttpServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, host, () => {
      probe.removeAllListeners("error");
      probe.close(resolve);
    });
  }).catch((error) => {
    throw new Error(`Port ${port} is already in use; stop the existing cockpit server first.`, {
      cause: error,
    });
  });
}

export async function startServer({
  backgroundSync = process.env.PRC_DISABLE_SYNC !== "1",
  development = process.argv.includes("--dev"),
} = {}) {
  await assertServerPortAvailable();
  const [{ createDashboardApiMiddleware }, { createDashboardService }] = await Promise.all([
    import("../analysis/dashboard-api.js"),
    import("../analysis/dashboard-service.js"),
  ]);
  await mkdir(reviewsDir, { recursive: true });
  const eventHub = createEventHub();
  const dashboardService = await createDashboardService({
    onChange: (change) => eventHub.publish("analysis", change),
    projectRoot,
    reviewsDir,
  });
  const dashboardApi = createDashboardApiMiddleware({ service: dashboardService });
  const server = createHttpServer();
  const appVite = development
    ? await import("vite").then(({ createServer }) =>
        createServer({
          appType: "spa",
          configFile: path.join(clientRoot, "vite.config.js"),
          root: clientRoot,
          server: { middlewareMode: true, ws: { server } },
        }),
      )
    : null;
  const scheduler = createSyncScheduler({
    fullSync: () => syncQueue(new Date()),
    notificationSync: () => syncNotifications(new Date()),
    onUpdate: ({ result }) => eventHub.publish("inbox", result),
  });
  let resourcesClosePromise;
  const closeResources = () => {
    resourcesClosePromise ??= (async () => {
      eventHub.close();
      await scheduler.stop();
      await dashboardService.close();
      await appVite?.close();
      await closeInboxStore();
    })();
    return resourcesClosePromise;
  };

  server.on("request", (request, response) => {
    if (rejectUntrustedRequestHost(request, response)) return;
    const pathname = requestPathname(request);
    if (pathname === null) {
      response.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end("Bad request");
      return;
    }
    if (rejectUntrustedApiMutation(request, response, pathname)) return;
    if (pathname === "/api/events") {
      eventHub.handle(request, response);
      return;
    }
    handleApiRequest(request, response, { dashboardService, eventHub, scheduler })
      .then(async (handled) => {
        if (handled) return;
        if (await handleReviewDraftApiRequest(request, response)) return;
        let dashboardHandled = true;
        await dashboardApi(request, response, () => {
          dashboardHandled = false;
        });
        if (dashboardHandled) return;
        if (await serveReviewArtifact(request, response)) return;
        if (!appVite) {
          if (await serveStaticFiles({ request, response, root: clientDistRoot })) return;
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }
        appVite.middlewares(request, response, () => {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not found");
        });
      })
      .catch((error) => {
        console.error("Cockpit request failed:", error);
        if (!response.headersSent) {
          response.writeHead(500, {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          });
        }
        response.end("Unexpected server error");
      });
  });
  server.once("close", () => {
    closeResources().catch((error) => console.error("Cockpit shutdown failed:", error));
  });
  let shutdownPromise;
  server.shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    eventHub.close();
    const serverClosed = new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    shutdownPromise = serverClosed.then(closeResources);
    return shutdownPromise;
  };
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    await closeResources();
    throw error;
  }
  if (backgroundSync) scheduler.start();
  console.log(`PR Review Cockpit: ${cockpitOrigin}/`);
  console.log(`Analysis queue: ${cockpitOrigin}/analysis`);
  console.log(`Mode: ${development ? "development" : "production"}`);
  if (!backgroundSync) console.log("Background GitHub sync: disabled");
  return server;
}

export function requestPathname(request) {
  try {
    return new URL(request.url, cockpitOrigin).pathname;
  } catch {
    return null;
  }
}
