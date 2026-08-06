import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createDashboardApiMiddleware } from "./dashboard-api.js";
import { createDashboardService } from "./dashboard-service.js";

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

      service = await serviceFactory({
        projectRoot,
        reviewsDir,
      });
      const apiMiddleware = createDashboardApiMiddleware({ service });
      viteServer.middlewares.use(async (request, response, next) => {
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
