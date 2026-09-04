import { fileURLToPath } from "node:url";
import { startServer } from "./http/http-server.js";

export { startServer } from "./http/http-server.js";
export * from "./http/review-files.js";
export * from "./inbox/inbox-service.js";
export * from "./runtime-config.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer()
    .then((result) => {
      const shutdown = () => {
        result.shutdown?.().catch((error) => {
          console.error("PR Constellation shutdown failed:", error);
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
