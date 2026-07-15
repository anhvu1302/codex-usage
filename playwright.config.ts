import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8788",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node scripts/reset-e2e-db.mjs && cross-env PORT=8788 CODEX_SESSIONS_DIR=e2e/fixtures/sessions CODEX_USAGE_DB=.local/e2e-usage.db pnpm prod",
    port: 8788,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
