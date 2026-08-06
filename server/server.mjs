import { fileURLToPath } from "node:url";
import { startServer } from "./http/http-server.js";
import { closeInboxStore, syncQueue } from "./inbox/inbox-service.js";

export { startServer } from "./http/http-server.js";
export * from "./http/review-files.js";
export * from "./inbox/inbox-service.js";
export * from "./runtime-config.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const syncOnly = process.argv[2] === "--sync";
  const command = syncOnly ? runOneShotSync() : startServer();
  command
    .then((result) => {
      if (syncOnly) {
        console.log(JSON.stringify(result));
        return;
      }
      const shutdown = () => {
        result.shutdown?.().catch((error) => {
          console.error("PR Review Cockpit shutdown failed:", error);
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

async function runOneShotSync() {
  const { createDashboardService } = await import("./analysis/dashboard-service.js");
  const { projectRoot, reviewsDir } = await import("./runtime-config.js");
  const dashboardService = await createDashboardService({ projectRoot, reviewsDir });
  try {
    return await syncQueue(new Date(), { dashboardService });
  } finally {
    await dashboardService.close();
    await closeInboxStore();
  }
}
