import { backfillAllUnpricedUsage, reconcileUnknownModels } from "@/server/analytics";
import { getConfig } from "@/server/config";
import { createDatabase, migrateDatabase } from "@/server/db/client";

const database = createDatabase(getConfig().databasePath);
migrateDatabase(database);

const reclassified = reconcileUnknownModels(database);
const backfilled = backfillAllUnpricedUsage(database);

console.log(
  `Repair complete: reclassified ${reclassified} usage event(s), backfilled ${backfilled}.`,
);
