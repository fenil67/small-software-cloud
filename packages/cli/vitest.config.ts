import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@ssc/client": path.resolve(__dirname, "../client/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
