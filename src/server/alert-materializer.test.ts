import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AlertMaterializer } from "@/server/alert-materializer";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import { alertEvents } from "@/server/db/schema";

let database: AppDatabase;
let directory: string;
let statements: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codex-usage-alert-materializer-"));
  statements = [];
  database = createDatabase(join(directory, "usage.db"), {
    onStatement: (statement) => statements.push(String(statement)),
  });
  migrateDatabase(database);
  statements = [];
});

afterEach(async () => {
  vi.useRealTimers();
  database.$client.close();
  await rm(directory, { force: true, recursive: true });
});

describe("AlertMaterializer", () => {
  it("refreshes once per dirty revision and keeps stable reads cheap", () => {
    const refresh = vi.fn();
    const materializer = new AlertMaterializer(database, { refresh });

    expect(materializer.getFeed()).toEqual({ alerts: [], unseenCount: 0 });
    expect(materializer.getFeed()).toEqual({ alerts: [], unseenCount: 0 });
    expect(refresh).toHaveBeenCalledTimes(1);

    materializer.invalidate();
    expect(materializer.getFeed()).toEqual({ alerts: [], unseenCount: 0 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("serves repeated stable reads with only feed and unseen-count selects", () => {
    const refresh = vi.fn();
    const materializer = new AlertMaterializer(database, { refresh });
    materializer.getFeed();
    statements = [];

    for (let index = 0; index < 10; index += 1) materializer.getFeed();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(20);
    expect(
      statements.every((statement) => statement.trimStart().toLowerCase().startsWith("select")),
    ).toBe(true);
  });

  it("coalesces scheduled work and cancels it on shutdown", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const materializer = new AlertMaterializer(database, { refresh });
    materializer.start();
    materializer.invalidate();
    materializer.invalidate();

    vi.runOnlyPendingTimers();
    expect(refresh).toHaveBeenCalledTimes(1);

    materializer.invalidate();
    materializer.stop();
    vi.runOnlyPendingTimers();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("uses trailing debounce with a hard max during sustained invalidations", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const materializer = new AlertMaterializer(database, { refresh });
    materializer.getFeed();
    refresh.mockClear();
    materializer.start();

    for (let second = 0; second < 15; second += 1) {
      materializer.invalidate("import");
      vi.advanceTimersByTime(1_000);
    }
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("publishes the highest-priority reason only when the feed changes", () => {
    vi.useFakeTimers();
    let shouldInsert = false;
    const onChanged = vi.fn();
    const refresh = vi.fn((value: AppDatabase) => {
      if (!shouldInsert) return;
      value
        .insert(alertEvents)
        .values({
          createdAt: 1,
          id: "changed-alert",
          message: "changed",
          periodStart: "2026-07-16",
          scopeKey: "changed",
          severity: "warning",
          title: "Changed",
          type: "anomaly",
        })
        .onConflictDoNothing()
        .run();
    });
    const materializer = new AlertMaterializer(database, { onChanged, refresh });
    materializer.getFeed();
    materializer.start();
    shouldInsert = true;
    materializer.invalidate("import");
    materializer.invalidate("rate");
    materializer.invalidate("budget");

    vi.advanceTimersByTime(2_000);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith("budget");

    materializer.invalidate("import");
    vi.advanceTimersByTime(2_000);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous feed and retries after a refresh failure", () => {
    const refresh = vi
      .fn<(database: AppDatabase, now: Date) => void>()
      .mockImplementationOnce((value) => {
        value
          .insert(alertEvents)
          .values({
            createdAt: 1,
            id: "partial-alert",
            message: "must roll back",
            periodStart: "2026-07-16",
            scopeKey: "partial",
            severity: "warning",
            title: "Partial",
            type: "anomaly",
          })
          .run();
        throw new Error("temporary refresh failure");
      });
    const materializer = new AlertMaterializer(database, { refresh });

    expect(materializer.getFeed()).toEqual({ alerts: [], unseenCount: 0 });
    expect(database.select().from(alertEvents).all()).toEqual([]);
    expect(materializer.getFeed()).toEqual({ alerts: [], unseenCount: 0 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
