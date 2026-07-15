import { rm } from "node:fs/promises";

const databasePath = ".local/e2e-usage.db";

await Promise.all(
  [databasePath, `${databasePath}-shm`, `${databasePath}-wal`].map((path) =>
    rm(path, { force: true }),
  ),
);
