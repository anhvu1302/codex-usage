import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "@/server/db/schema";

export type AppDatabase = ReturnType<typeof createDatabase>;

export function createDatabase(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  const client = new BetterSqlite3(filePath);
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");

  return drizzle({ client, schema });
}

export function migrateDatabase(database: AppDatabase) {
  migrate(database, { migrationsFolder: "drizzle" });
}
