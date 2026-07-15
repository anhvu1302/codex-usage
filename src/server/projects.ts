import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { AppDatabase } from "@/server/db/client";
import { projects, sessions } from "@/server/db/schema";
import { getProjectName, normalizeProjectPath } from "@/server/insights";

const UNKNOWN_PROJECT_ID = "legacy-unknown";

export function ensureProject(
  database: AppDatabase,
  cwd: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!cwd) {
    ensureUnknownProject(database);
    return UNKNOWN_PROJECT_ID;
  }

  const normalizedPath = normalizeProjectPath(cwd, platform);
  const id = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 24);
  const now = Date.now();
  database
    .insert(projects)
    .values({
      createdAt: now,
      displayName: getProjectName(cwd, platform),
      displayPath: cwd,
      id,
      normalizedPath,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projects.normalizedPath,
      set: { displayPath: cwd, updatedAt: now },
    })
    .run();
  return id;
}

export function backfillProjects(database: AppDatabase) {
  ensureUnknownProject(database);
  for (const session of database
    .select({ cwd: sessions.cwd, id: sessions.id })
    .from(sessions)
    .all()) {
    const projectId = ensureProject(database, session.cwd);
    database.update(sessions).set({ projectId }).where(eq(sessions.id, session.id)).run();
  }
}

export function renameProject(database: AppDatabase, id: string, displayName: string) {
  const updatedAt = Date.now();
  const result = database
    .update(projects)
    .set({ displayName, updatedAt })
    .where(eq(projects.id, id))
    .run();
  return result.changes > 0 ? getProject(database, id) : null;
}

function getProject(database: AppDatabase, id: string) {
  return database.select().from(projects).where(eq(projects.id, id)).get() ?? null;
}

function ensureUnknownProject(database: AppDatabase) {
  const now = Date.now();
  database
    .insert(projects)
    .values({
      createdAt: now,
      displayName: "Không xác định",
      displayPath: "",
      id: UNKNOWN_PROJECT_ID,
      normalizedPath: UNKNOWN_PROJECT_ID,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}
