import { getConfig } from "@/server/config";
import { createDatabase, migrateDatabase } from "@/server/db/client";

const database = createDatabase(getConfig().databasePath);
migrateDatabase(database);
console.log("Database migration completed.");
