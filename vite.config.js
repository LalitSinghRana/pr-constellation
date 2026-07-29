import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { createDashboardVitePlugin } from "./cli/dashboard-vite-plugin.js";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const configuredReviewsDir = process.env.PRC_REVIEWS_DIR;
const reviewsDir = configuredReviewsDir
  ? path.resolve(projectRoot, configuredReviewsDir)
  : path.join(projectRoot, ".reviews");

export default defineConfig({
  appType: "mpa",
  base: "/reviews/",
  plugins: [
    createDashboardVitePlugin({
      projectRoot,
      reviewsDir,
    }),
  ],
  root: configuredReviewsDir ? reviewsDir : ".reviews",
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
