import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createDashboardApiMiddleware } from "./dashboard-api.js";
import { createDashboardService } from "./dashboard-service.js";
import { createFixtureApiMiddleware } from "./fixture-api.js";
import { createFixtureRunService } from "./fixture-runs.js";

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
      const fixtureApiMiddleware = createFixtureApiMiddleware({
        service: createFixtureRunService({ reviewsDir }),
      });

      // fixtureApiMiddleware must run first: dashboardApiMiddleware answers
      // every /api/* path itself (404 on no match) instead of calling next().
      viteServer.middlewares.use(async (request, response, next) => {
        await fixtureApiMiddleware(request, response, next);
      });
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
