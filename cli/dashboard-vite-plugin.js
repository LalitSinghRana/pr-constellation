import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDashboardApiMiddleware } from "./dashboard-api.js";
import { createDashboardService } from "./dashboard-service.js";
import { renderDashboardHtml } from "../src/dashboard-render.js";

export function createDashboardVitePlugin({
  projectRoot = process.cwd(),
  reviewsDir = path.resolve(projectRoot, ".reviews"),
  serviceFactory = createDashboardService,
} = {}) {
  let service = null;

  return {
    name: "pr-review-dashboard",

    async configureServer(viteServer) {
      await mkdir(reviewsDir, { recursive: true });
      await writeFile(
        path.join(reviewsDir, "index.html"),
        await renderDashboardHtml(),
        "utf8",
      );

      service = await serviceFactory({
        projectRoot,
        reviewsDir,
      });
      const apiMiddleware = createDashboardApiMiddleware({ service });

      viteServer.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/") {
          response.statusCode = 302;
          response.setHeader("Location", "/reviews/");
          response.end();
          return;
        }

        await apiMiddleware(request, response, next);
      });

      viteServer.httpServer?.once("close", () => {
        service?.close();
      });
    },

    getDashboardService() {
      return service;
    },
  };
}
