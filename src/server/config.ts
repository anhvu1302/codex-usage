import "dotenv/config";

import { homedir } from "node:os";
import { join } from "node:path";

export const TIME_ZONE = "Asia/Ho_Chi_Minh";

export type AppConfig = {
  databasePath: string;
  port: number;
  scanIntervalMinutes: number;
  sessionsDirectory: string;
};

export function getConfig(environment = process.env): AppConfig {
  const port = Number.parseInt(environment["PORT"] ?? "8787", 10);
  const scanIntervalMinutes = parseBoundedInteger(
    environment["CODEX_USAGE_SCAN_INTERVAL_MINUTES"],
    15,
    1,
    1_440,
  );
  const codexHome = environment["CODEX_HOME"] ?? join(homedir(), ".codex");

  return {
    databasePath:
      environment["CODEX_USAGE_DB"] ?? join(homedir(), ".codex-usage", "codex-usage.db"),
    port: Number.isSafeInteger(port) && port > 0 ? port : 8787,
    scanIntervalMinutes,
    sessionsDirectory: environment["CODEX_SESSIONS_DIR"] ?? join(codexHome, "sessions"),
  };
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
