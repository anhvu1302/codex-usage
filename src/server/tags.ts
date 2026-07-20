import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import type { AppDatabase } from "@/server/db/client";
import { projectTags, projects, tags } from "@/server/db/schema";
import type { ProjectTag, Tag, TagsResponse } from "@/shared/types";

const MAX_TAGS_PER_PROJECT = 50;
const MAX_TAG_NAME_LENGTH = 48;
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/u;

export class InvalidTagNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTagNameError";
  }
}

export class TagNameConflictError extends Error {
  constructor() {
    super("A tag with this name already exists");
    this.name = "TagNameConflictError";
  }
}

export function normalizeTagName(value: string): { name: string; normalizedName: string } {
  const unicodeNormalized = value.normalize("NFKC");
  if (CONTROL_CHARACTER_PATTERN.test(unicodeNormalized)) {
    throw new InvalidTagNameError("Tag name must not contain control characters");
  }
  const name = unicodeNormalized.trim().replaceAll(/\s+/gu, " ");
  const length = [...name].length;
  if (length === 0 || length > MAX_TAG_NAME_LENGTH) {
    throw new InvalidTagNameError("Tag name must contain between 1 and 48 characters");
  }
  return { name, normalizedName: name.toLocaleLowerCase("en-US") };
}

export function getTags(database: AppDatabase): TagsResponse {
  const rows = database
    .select({
      createdAt: tags.createdAt,
      id: tags.id,
      name: tags.name,
      projectCount: sql<number>`count(${projectTags.projectId})`,
      updatedAt: tags.updatedAt,
    })
    .from(tags)
    .leftJoin(projectTags, eq(projectTags.tagId, tags.id))
    .groupBy(tags.id, tags.name, tags.createdAt, tags.updatedAt, tags.normalizedName)
    .orderBy(asc(tags.normalizedName), asc(tags.id))
    .all();
  return {
    tags: rows.map((row) => ({
      createdAt: new Date(row.createdAt).toISOString(),
      id: row.id,
      name: row.name,
      projectCount: Number(row.projectCount),
      updatedAt: new Date(row.updatedAt).toISOString(),
    })),
  };
}

export function createTag(database: AppDatabase, value: string): Tag {
  const normalized = normalizeTagName(value);
  if (findTagByNormalizedName(database, normalized.normalizedName)) {
    throw new TagNameConflictError();
  }
  const now = Date.now();
  const id = randomUUID();
  database
    .insert(tags)
    .values({
      createdAt: now,
      id,
      name: normalized.name,
      normalizedName: normalized.normalizedName,
      updatedAt: now,
    })
    .run();
  return {
    createdAt: new Date(now).toISOString(),
    id,
    name: normalized.name,
    updatedAt: new Date(now).toISOString(),
  };
}

export function renameTag(database: AppDatabase, id: string, value: string): Tag | null {
  const current = database.select().from(tags).where(eq(tags.id, id)).get();
  if (!current) return null;
  const normalized = normalizeTagName(value);
  const conflict = database
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.normalizedName, normalized.normalizedName), ne(tags.id, id)))
    .get();
  if (conflict) throw new TagNameConflictError();
  const updatedAt = Date.now();
  database
    .update(tags)
    .set({ name: normalized.name, normalizedName: normalized.normalizedName, updatedAt })
    .where(eq(tags.id, id))
    .run();
  return {
    createdAt: new Date(current.createdAt).toISOString(),
    id,
    name: normalized.name,
    updatedAt: new Date(updatedAt).toISOString(),
  };
}

export function deleteTag(database: AppDatabase, id: string): boolean {
  return database.delete(tags).where(eq(tags.id, id)).run().changes > 0;
}

export function replaceProjectTags(
  database: AppDatabase,
  projectId: string,
  tagIds: string[],
):
  | { status: "ok"; tags: ProjectTag[] }
  | { status: "project-not-found" }
  | { status: "tag-not-found" } {
  const project = database
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) return { status: "project-not-found" };
  const uniqueTagIds = [...new Set(tagIds)];
  if (uniqueTagIds.length > MAX_TAGS_PER_PROJECT) {
    throw new RangeError("A project can have at most 50 tags");
  }
  const selected =
    uniqueTagIds.length === 0
      ? []
      : database
          .select({ id: tags.id, name: tags.name, normalizedName: tags.normalizedName })
          .from(tags)
          .where(inArray(tags.id, uniqueTagIds))
          .orderBy(asc(tags.normalizedName), asc(tags.id))
          .all();
  if (selected.length !== uniqueTagIds.length) return { status: "tag-not-found" };

  const createdAt = Date.now();
  database.transaction((transaction) => {
    transaction.delete(projectTags).where(eq(projectTags.projectId, projectId)).run();
    if (uniqueTagIds.length > 0) {
      transaction
        .insert(projectTags)
        .values(uniqueTagIds.map((tagId) => ({ createdAt, projectId, tagId })))
        .run();
    }
  });
  return {
    status: "ok",
    tags: selected.map(({ id, name }) => ({ id, name })),
  };
}

export function getProjectTagMap(
  database: AppDatabase,
  projectIds: string[],
): Map<string, ProjectTag[]> {
  const result = new Map<string, ProjectTag[]>();
  const uniqueProjectIds = [...new Set(projectIds)];
  if (uniqueProjectIds.length === 0) return result;
  const rows = database
    .select({
      id: tags.id,
      name: tags.name,
      projectId: projectTags.projectId,
    })
    .from(projectTags)
    .innerJoin(tags, eq(tags.id, projectTags.tagId))
    .where(inArray(projectTags.projectId, uniqueProjectIds))
    .orderBy(asc(tags.normalizedName), asc(tags.id))
    .all();
  for (const row of rows) {
    const values = result.get(row.projectId) ?? [];
    values.push({ id: row.id, name: row.name });
    result.set(row.projectId, values);
  }
  return result;
}

function findTagByNormalizedName(database: AppDatabase, normalizedName: string) {
  return database
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.normalizedName, normalizedName))
    .get();
}
