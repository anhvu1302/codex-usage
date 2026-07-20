import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import { projectTags, projects } from "@/server/db/schema";
import {
  createTag,
  deleteTag,
  getTags,
  InvalidTagNameError,
  normalizeTagName,
  renameTag,
  replaceProjectTags,
  TagNameConflictError,
} from "@/server/tags";

let database: AppDatabase;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codex-usage-tags-test-"));
  database = createDatabase(join(directory, "usage.db"));
  migrateDatabase(database);
  database
    .insert(projects)
    .values([
      {
        createdAt: 1,
        displayName: "Alpha",
        displayPath: "/alpha",
        id: "project-alpha",
        normalizedPath: "/alpha",
        updatedAt: 1,
      },
      {
        createdAt: 1,
        displayName: "Beta",
        displayPath: "/beta",
        id: "project-beta",
        normalizedPath: "/beta",
        updatedAt: 1,
      },
    ])
    .run();
});

afterEach(async () => {
  database.$client.close();
  await rm(directory, { force: true, recursive: true });
});

describe("project tags", () => {
  it("normalizes NFKC, whitespace and case while rejecting control characters", () => {
    expect(normalizeTagName("  Ｐｒｏｄ   Team  ")).toEqual({
      name: "Prod Team",
      normalizedName: "prod team",
    });
    expect(() => normalizeTagName("bad\nname")).toThrow(InvalidTagNameError);
    expect(() => normalizeTagName("x".repeat(49))).toThrow(
      "Tag name must contain between 1 and 48 characters",
    );

    const first = createTag(database, "  Ｐｒｏｄ   Team  ");
    expect(first.name).toBe("Prod Team");
    expect(() => createTag(database, "prod team")).toThrow(TagNameConflictError);
    const second = createTag(database, "Internal");
    expect(() => renameTag(database, second.id, "PROD TEAM")).toThrow(TagNameConflictError);
    expect(renameTag(database, "missing", "Other")).toBeNull();
  });

  it("replaces assignments transactionally and cascades tag/project deletion", () => {
    const production = createTag(database, "Production");
    const internal = createTag(database, "Internal");
    expect(
      replaceProjectTags(database, "project-alpha", [production.id, internal.id, production.id]),
    ).toEqual({
      status: "ok",
      tags: [
        { id: internal.id, name: "Internal" },
        { id: production.id, name: "Production" },
      ],
    });
    expect(getTags(database).tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: production.id, projectCount: 1 }),
        expect.objectContaining({ id: internal.id, projectCount: 1 }),
      ]),
    );

    expect(replaceProjectTags(database, "missing", [production.id])).toEqual({
      status: "project-not-found",
    });
    expect(replaceProjectTags(database, "project-alpha", [crypto.randomUUID()])).toEqual({
      status: "tag-not-found",
    });
    expect(
      database.select().from(projectTags).where(eq(projectTags.projectId, "project-alpha")).all(),
    ).toHaveLength(2);
    expect(() =>
      replaceProjectTags(
        database,
        "project-alpha",
        Array.from({ length: 51 }, () => crypto.randomUUID()),
      ),
    ).toThrow("A project can have at most 50 tags");

    expect(deleteTag(database, production.id)).toBe(true);
    expect(deleteTag(database, production.id)).toBe(false);
    expect(
      database.select().from(projectTags).where(eq(projectTags.projectId, "project-alpha")).all(),
    ).toEqual([expect.objectContaining({ tagId: internal.id })]);

    database.delete(projects).where(eq(projects.id, "project-alpha")).run();
    expect(database.select().from(projectTags).all()).toEqual([]);
  });
});
