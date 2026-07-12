import "dotenv/config";

import { homedir } from "node:os";
import { join } from "node:path";

export const TIME_ZONE = "Asia/Ho_Chi_Minh";

export type AppConfig = {
  databasePath: string;
  port: number;
  sessionsDirectory: string;
};

export function getConfig(environment = process.env): AppConfig {
  const port = Number.parseInt(environment["PORT"] ?? "8787", 10);

  return {
    databasePath:
      environment["CODEX_USAGE_DB"] ?? join(homedir(), ".codex-usage", "codex-usage.db"),
    port: Number.isSafeInteger(port) && port > 0 ? port : 8787,
    sessionsDirectory: environment["CODEX_SESSIONS_DIR"] ?? join(homedir(), ".codex", "sessions"),
  };
}
