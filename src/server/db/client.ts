import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "@/server/db/schema";

export type AppDatabase = ReturnType<typeof createDatabase>;

export function createDatabase(
  filePath: string,
  options: { onStatement?: (statement: unknown) => void } = {},
) {
  mkdirSync(dirname(filePath), { recursive: true });
  const client = new BetterSqlite3(filePath, { verbose: options.onStatement });
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.pragma("synchronous = NORMAL");

  return drizzle({ client, schema });
}

export function migrateDatabase(database: AppDatabase) {
  migrate(database, { migrationsFolder: "drizzle" });
  const client = database.$client;
  if (client.pragma("auto_vacuum", { simple: true }) !== 2) {
    client.pragma("auto_vacuum = INCREMENTAL");
    client.exec("VACUUM");
  }
}

export function reclaimDatabaseSpace(database: AppDatabase) {
  const client = database.$client;
  client.pragma("incremental_vacuum");
  client.pragma("wal_checkpoint(TRUNCATE)");
  client.pragma("optimize");
}
