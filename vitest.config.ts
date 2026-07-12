import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/server/**/*.ts"],
      exclude: ["src/server/index.ts", "src/server/migrate.ts"],
      thresholds: {
        statements: 85,
        functions: 85,
        lines: 85,
        branches: 80,
      },
    },
  },
});
