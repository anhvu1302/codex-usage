import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  backfillUnpricedUsage,
  getDashboard,
  getKnownModels,
  getModelRates,
  getSessions,
  reconcileUnknownModels,
  upsertModelRate,
} from "@/server/analytics";
import { createApp } from "@/server/app";
import { getConfig } from "@/server/config";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import {
  activityEvents,
  archivedActivityEventIds,
  archivedUsageEventIds,
  importDiagnostics,
  importStates,
  sessionAgents,
  sessions,
  turnActivityRollups,
  turnBackfillState,
  turnModelUsage,
  turns,
  usageAgentDailyRollups,
  usageDailyRollups,
  usageEvents,
  usageHourlyRollups,
  usageRollupSessionMemberships,
} from "@/server/db/schema";
import { parseActivityRecord } from "@/server/activity-parser";
import {
  calculateCost,
  createTurnKey,
  normalizeTokenUsage,
  SessionImporter,
  toLocalDate,
} from "@/server/importer";
import { compactUsage, RetentionService } from "@/server/retention";
import {
  readSourceFileMetadata,
  SourceInventory,
  type SourceInventoryScanner,
} from "@/server/source-inventory";
import type { DataHealthResponse, ImportStatus, StorageStatus } from "@/shared/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("token usage parsing", () => {
  it("normalizes cached and reasoning tokens without counting reasoning twice", () => {
    const usage = normalizeTokenUsage({
      cached_input_tokens: 150,
      input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 30,
    });

    expect(usage).toEqual({
      cachedInputTokens: 100,
      inputTokens: 100,
      outputTokens: 20,
      reasoningOutputTokens: 20,
      totalTokens: 120,
    });
    expect(
      calculateCost(usage!, { cachedInputRate: 0.5, inputRate: 2, outputRate: 4 }),
    ).toBeCloseTo(0.00013);
    expect(normalizeTokenUsage({ input_tokens: "bad" })).toBeNull();
  });

  it("groups timestamps using the configured Vietnam timezone", () => {
    expect(toLocalDate("2026-07-11T17:30:00.000Z")).toBe("2026-07-12");
    expect(toLocalDate("not-a-timestamp")).toBeNull();
  });

  it("uses safe local defaults and honours custom config", () => {
    expect(getConfig({ PORT: "not-a-port" }).port).toBe(8787);
    expect(getConfig({ CODEX_USAGE_SCAN_INTERVAL_MINUTES: "0" }).scanIntervalMinutes).toBe(15);
    expect(getConfig({ CODEX_USAGE_SCAN_INTERVAL_MINUTES: "1441" }).scanIntervalMinutes).toBe(15);
    expect(getConfig({ CODEX_USAGE_SCAN_INTERVAL_MINUTES: "60" }).scanIntervalMinutes).toBe(60);
    expect(getConfig({ CODEX_HOME: "/custom/codex-home" }).sessionsDirectory).toBe(
      "/custom/codex-home/sessions",
    );
    expect(
      getConfig({
        CODEX_SESSIONS_DIR: "/tmp/sessions",
        CODEX_USAGE_DB: "/tmp/usage.db",
        PORT: "9123",
      }),
    ).toEqual({
      databasePath: "/tmp/usage.db",
      port: 9123,
      scanIntervalMinutes: 15,
      sessionsDirectory: "/tmp/sessions",
    });
  });
});

describe("session importer", () => {
  it("attributes explicit turns per canonical agent and derives cross-day lifecycle metrics", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-turns"),
      tokenCount("2026-07-12T16:58:00.000Z", 10, 2, 1, 1),
      taskStarted("shared-turn", "2026-07-12T16:59:00.000Z", 750),
      turnContext("gpt-turn", "2026-07-12T16:59:01.000Z", "shared-turn"),
      tokenCount("2026-07-12T17:01:00.000Z", 100, 80, 10, 4, undefined, "shared-turn"),
      taskCompleted("shared-turn", "2026-07-12T17:02:00.000Z"),
      taskCompleted("missing-turn", "2026-07-12T17:03:00.000Z"),
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-turns", {
        agentId: "agent-turns",
        depth: 1,
        name: "Mapper",
        parentThreadId: "session-turns",
        threadSource: "subagent",
      }),
      taskStarted("shared-turn", "2026-07-12T17:04:00.000Z"),
      turnContext("gpt-turn", "2026-07-12T17:04:01.000Z", "shared-turn"),
      tokenCount("2026-07-12T17:04:02.000Z", 20, 10, 2, 1, undefined, "shared-turn"),
      taskAborted("shared-turn", "2026-07-12T17:04:03.000Z"),
    ]);

    expect((await harness.importer.syncAll()).error).toBeNull();
    const importedTurns = harness.database.select().from(turns).orderBy(turns.startedAt).all();
    expect(importedTurns).toHaveLength(2);
    expect(importedTurns.map((turn) => turn.id)).toEqual([
      createTurnKey("session-turns", "shared-turn"),
      createTurnKey("agent-turns", "shared-turn"),
    ]);
    expect(importedTurns[0]).toMatchObject({
      durationMs: 180_000,
      localDate: "2026-07-12",
      status: "completed",
      timeToFirstTokenMs: 750,
    });
    expect(importedTurns[1]).toMatchObject({
      durationMs: 3_000,
      status: "aborted",
      timeToFirstTokenMs: null,
    });
    expect(
      harness.database.select().from(turns).where(eq(turns.turnId, "missing-turn")).get(),
    ).toBeUndefined();

    const events = harness.database.select().from(usageEvents).orderBy(usageEvents.timestamp).all();
    expect(events[0]?.turnKey).toBeNull();
    expect(events.slice(1).map((event) => event.turnKey)).toEqual([
      createTurnKey("session-turns", "shared-turn"),
      createTurnKey("agent-turns", "shared-turn"),
    ]);
    expect(harness.database.select().from(turnModelUsage).all()).toHaveLength(2);
    expect(
      harness.database
        .select()
        .from(turnActivityRollups)
        .where(eq(turnActivityRollups.kind, "task_completed"))
        .all(),
    ).toHaveLength(1);
  });

  it("rolls back attribution markers with aggregates and repairs safely on rescan", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-atomic-turn"),
      taskStarted("turn-atomic", "2026-07-12T01:00:00.000Z"),
      turnContext("gpt-atomic", "2026-07-12T01:00:00.100Z", "turn-atomic"),
      tokenCount("2026-07-12T01:00:01.000Z", 100, 20, 10, 2),
    ]);
    harness.database.$client.exec(`
      create trigger fail_turn_usage before insert on turn_model_usage
      begin select raise(abort, 'forced turn aggregate failure'); end;
    `);

    expect((await harness.importer.syncAll()).error).toContain("forced turn aggregate failure");
    expect(harness.database.select().from(usageEvents).get()).toMatchObject({
      turnAttributionVersion: 0,
      turnKey: null,
    });
    expect(harness.database.select().from(turnModelUsage).all()).toHaveLength(0);

    harness.database.$client.exec("drop trigger fail_turn_usage");
    expect((await harness.importer.syncAll()).error).toBeNull();
    expect(harness.database.select().from(usageEvents).get()).toMatchObject({
      turnAttributionVersion: 1,
      turnKey: createTurnKey("session-atomic-turn", "turn-atomic"),
    });
    expect(harness.database.select().from(turnModelUsage).get()).toMatchObject({
      requestCount: 1,
      totalTokens: 110,
    });
    expect((await harness.importer.syncAll()).recordsInserted).toBe(0);
    expect(harness.database.select().from(turnModelUsage).get()?.requestCount).toBe(1);
  });

  it("finishes a stale turn backfill marker after restart", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-stale-backfill"),
      taskStarted("turn-stale-backfill", "2026-07-12T01:00:00.000Z"),
      turnContext("gpt-stale", "2026-07-12T01:00:01.000Z", "turn-stale-backfill"),
      tokenCount("2026-07-12T01:00:02.000Z", 10, 2, 1, 0),
    ]);
    await harness.importer.syncAll();
    harness.database.update(turnBackfillState).set({ error: null, isRunning: true }).run();

    const restarted = new SessionImporter(harness.database, harness.sessionsDirectory);
    const status = await restarted.syncAll();

    expect(status.error).toBeNull();
    expect(status.turnBackfill).toMatchObject({
      attributionVersion: 1,
      isRunning: false,
      sourceDeletedGaps: 0,
    });

    harness.database
      .update(turnBackfillState)
      .set({ error: "crash after final import state", isRunning: false })
      .run();
    const recovered = await new SessionImporter(
      harness.database,
      harness.sessionsDirectory,
    ).syncAll();
    expect(recovered.turnBackfill).toMatchObject({ error: null, isRunning: false });
  });

  it("records deleted-source gaps without blocking compaction and rescans restored files", async () => {
    const harness = await createHarness();
    const lines = [
      sessionMeta("session-deleted-turn-source"),
      tokenCount("2026-07-01T01:00:00.000Z", 30, 10, 5, 2),
    ];
    const source = await createSessionFile(harness.sessionsDirectory, lines);
    await harness.importer.syncAll();
    harness.database
      .update(importStates)
      .set({ turnAttributionVersion: 0 })
      .where(eq(importStates.sourcePath, source))
      .run();
    await rm(source);

    const deleted = await harness.importer.syncAll();
    expect(deleted.turnBackfill.sourceDeletedGaps).toBe(1);
    expect(harness.database.select().from(importStates).get()?.turnAttributionVersion).toBe(0);
    expect(harness.database.select().from(usageEvents).get()?.turnAttributionVersion).toBe(1);
    expect(() =>
      compactUsage(harness.database, new Date("2026-09-01T00:00:00.000Z")),
    ).not.toThrow();
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(0);
    expect(harness.database.select().from(archivedUsageEventIds).all()).toHaveLength(1);

    await writeFile(source, `${lines.join("\n")}\n`);
    await harness.importer.syncFile(source);
    const restored = harness.importer.getStatus();
    expect(restored.error).toBeNull();
    expect(restored.turnBackfill.sourceDeletedGaps).toBe(0);
    expect(harness.database.select().from(importStates).get()?.turnAttributionVersion).toBe(1);
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(0);
  });

  it("is idempotent, resumes a partial tail, and preserves history after source deletion", async () => {
    const harness = await createHarness();
    const source = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-idempotent"),
      turnContext("gpt-5.6-sol"),
      tokenCount("2026-07-11T17:30:00.000Z", 120, 40, 30, 20),
    ]);

    expect((await harness.importer.syncAll()).recordsInserted).toBe(1);
    expect((await harness.importer.syncAll()).recordsInserted).toBe(0);
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);

    await appendFile(source, `${tokenCount("2026-07-11T17:31:00.000Z", 150, 50, 20, 4)}\n`);
    expect((await harness.importer.syncAll()).recordsInserted).toBe(1);

    await appendFile(source, tokenCount("2026-07-11T17:32:00.000Z", 80, 0, 10, 5));
    expect((await harness.importer.syncAll()).recordsInserted).toBe(0);
    await appendFile(source, "\n");
    expect((await harness.importer.syncAll()).recordsInserted).toBe(1);

    const usage = harness.database.select().from(usageEvents).orderBy(usageEvents.timestamp).all();
    expect(usage).toHaveLength(3);
    expect(usage[0]).toMatchObject({
      cachedInputTokens: 40,
      inputTokens: 120,
      localDate: "2026-07-12",
      model: "gpt-5.6-sol",
      outputTokens: 30,
      reasoningOutputTokens: 20,
      totalTokens: 150,
    });

    await rm(source);
    harness.database
      .update(importStates)
      .set({ dedupeVersion: 0 })
      .where(eq(importStates.sourcePath, source))
      .run();
    const deletedSourceSync = await harness.importer.syncAll();
    const session = harness.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, "session-idempotent"))
      .get();
    expect(deletedSourceSync.error).toBeNull();
    expect(session?.sourceDeleted).toBe(true);
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(3);
  });

  it("inventories every source while reading only metadata-stale JSONL", async () => {
    const harness = await createHarness();
    const firstSource = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-fast-one"),
      turnContext("gpt-fast"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
    ]);
    const secondSource = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-fast-two"),
      turnContext("gpt-fast"),
      tokenCount("2026-07-12T01:01:00.000Z", 100, 20, 10, 4),
    ]);

    const cold = await harness.importer.syncAll();
    expect(cold).toMatchObject({ filesProcessed: 2 });
    expect(cold.sourceScan.lastCompleted).toMatchObject({
      discoveredFiles: 2,
      filesRead: 2,
      filesSkipped: 0,
      mode: "inventory",
    });
    expect(
      harness.database
        .select()
        .from(importStates)
        .all()
        .every(
          (state) =>
            state.sourceSize !== null &&
            state.sourceMtimeNs !== null &&
            state.sourceCtimeNs !== null,
        ),
    ).toBe(true);

    harness.database
      .update(importStates)
      .set({
        sourceCtimeNs: null,
        sourceFileId: null,
        sourceMtimeNs: null,
        sourceSize: null,
      })
      .where(eq(importStates.sourcePath, firstSource))
      .run();
    const legacyMetadata = await harness.importer.syncAll();
    expect(legacyMetadata.sourceScan.lastCompleted).toMatchObject({
      filesRead: 1,
      filesSkipped: 1,
    });
    expect(
      harness.database
        .select()
        .from(importStates)
        .where(eq(importStates.sourcePath, firstSource))
        .get(),
    ).toMatchObject({
      sourceCtimeNs: expect.any(String),
      sourceMtimeNs: expect.any(String),
      sourceSize: expect.any(Number),
    });

    const warm = await harness.importer.syncAll();
    expect(warm).toMatchObject({ filesProcessed: 2, recordsInserted: 0 });
    expect(warm.sourceScan.lastCompleted).toMatchObject({ filesRead: 0, filesSkipped: 2 });

    await appendFile(firstSource, "\n");
    const appended = await harness.importer.syncAll();
    expect(appended.sourceScan.lastCompleted).toMatchObject({ filesRead: 1, filesSkipped: 1 });

    const unchangedContent = await readFile(secondSource);
    await writeFile(secondSource, unchangedContent);
    const rewrittenAt = new Date(Date.now() + 2_000);
    await utimes(secondSource, rewrittenAt, rewrittenAt);
    const sameSizeRewrite = await harness.importer.syncAll();
    expect(sameSizeRewrite.sourceScan.lastCompleted).toMatchObject({
      filesRead: 1,
      filesSkipped: 1,
    });

    harness.database
      .update(importStates)
      .set({ dedupeVersion: 0 })
      .where(eq(importStates.sourcePath, secondSource))
      .run();
    const repair = await harness.importer.syncAll();
    expect(repair.sourceScan.lastCompleted).toMatchObject({ filesRead: 2, filesSkipped: 0 });
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(2);
  });

  it("keeps exact dedupe and source flags across rename, delete and restore", async () => {
    const harness = await createHarness();
    const source = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-source-lifecycle"),
      turnContext("gpt-lifecycle"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
    ]);
    const content = await readFile(source);
    await harness.importer.syncAll();

    const renamed = join(dirname(source), "renamed.jsonl");
    await rename(source, renamed);
    const renamedStatus = await harness.importer.syncAll();
    expect(renamedStatus.sourceScan.lastCompleted).toMatchObject({ filesRead: 1 });
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
    expect(
      harness.database
        .select()
        .from(sessions)
        .where(eq(sessions.id, "session-source-lifecycle"))
        .get(),
    ).toMatchObject({ sourceDeleted: false, sourcePath: renamed });

    await rm(renamed);
    await harness.importer.syncAll();
    expect(
      harness.database
        .select()
        .from(sessions)
        .where(eq(sessions.id, "session-source-lifecycle"))
        .get(),
    ).toMatchObject({ sourceDeleted: true });

    await writeFile(renamed, content);
    await harness.importer.syncAll();
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
    expect(
      harness.database
        .select()
        .from(sessions)
        .where(eq(sessions.id, "session-source-lifecycle"))
        .get(),
    ).toMatchObject({ sourceDeleted: false });
  });

  it("keeps the last complete source snapshot when inventory fails", async () => {
    let sourcePath = "";
    let failInventory = false;
    const harness = await createHarness({
      createInventory: (directory) =>
        new SourceInventory(
          directory,
          () => new Date(),
          32,
          async () => {
            if (failInventory) throw new Error("forced inventory failure");
            const metadata = sourcePath ? await readSourceFileMetadata(sourcePath) : null;
            return {
              files: metadata ? [metadata] : [],
              sourceBytes: metadata?.size ?? 0,
            };
          },
        ),
    });
    sourcePath = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-inventory-failure"),
      turnContext("gpt-inventory-failure"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
    ]);
    await harness.importer.syncAll();
    await rm(sourcePath);
    failInventory = true;

    const failed = await harness.importer.syncAll();
    expect(failed.error).toBe("forced inventory failure");
    expect(harness.inventory.getSnapshot()).toMatchObject({ sourceFileCount: 1 });
    expect(
      harness.database
        .select()
        .from(sessions)
        .where(eq(sessions.id, "session-inventory-failure"))
        .get(),
    ).toMatchObject({ sourceDeleted: false });
  });

  it("coalesces overlapping inventory requests, repairs watcher misses, and cancels scheduling on stop", async () => {
    const harness = await createHarness({ scanIntervalMs: 25 });
    const source = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-scheduled-recovery"),
      turnContext("gpt-scheduled"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
    ]);
    const scansBefore = harness.inventory.getScanCount();

    const watcherReady = harness.importer.start();
    const statuses = await Promise.all([
      harness.importer.syncAll(),
      harness.importer.syncAll(),
      harness.importer.syncAll(),
    ]);
    await watcherReady;
    expect(statuses.every((status) => status.error === null)).toBe(true);
    expect(harness.inventory.getScanCount() - scansBefore).toBe(1);

    await appendFile(source, `${tokenCount("2026-07-12T01:01:00.000Z", 120, 20, 10, 4)}\n`);
    await vi.waitFor(
      () => {
        expect(harness.database.select().from(usageEvents).all()).toHaveLength(2);
        expect(harness.importer.getStatus().sourceScan.lastCompleted?.trigger).toBe("scheduled");
      },
      { interval: 10, timeout: 2_000 },
    );

    await harness.importer.stop();
    const scansAfterStop = harness.inventory.getScanCount();
    harness.database.$client.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    expect(harness.inventory.getScanCount()).toBe(scansAfterStop);
  });

  it("snapshots a current price and backfills only usage that was previously unpriced", async () => {
    const harness = await createHarness();
    const source = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-price"),
      turnContext("gpt-priced"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
    ]);

    await harness.importer.syncAll();
    expect(harness.database.select().from(usageEvents).get()?.costUsd).toBeNull();

    upsertModelRate(harness.database, {
      cachedInputRate: 0.5,
      inputRate: 2,
      model: "gpt-priced",
      outputRate: 4,
    });
    expect(backfillUnpricedUsage(harness.database, "gpt-priced")).toBe(1);
    expect(backfillUnpricedUsage(harness.database, "gpt-priced")).toBe(0);
    expect(harness.database.select().from(usageEvents).get()?.costUsd).toBeCloseTo(0.00021);

    upsertModelRate(harness.database, {
      cachedInputRate: 1,
      inputRate: 3,
      model: "gpt-priced",
      outputRate: 5,
    });
    harness.importer.clearRateCache();
    await appendFile(source, `${tokenCount("2026-07-12T01:01:00.000Z", 100, 20, 10, 4)}\n`);
    await harness.importer.syncAll();

    const costs = harness.database
      .select({ costUsd: usageEvents.costUsd })
      .from(usageEvents)
      .orderBy(usageEvents.timestamp)
      .all();
    expect(costs.map((event) => event.costUsd)).toEqual([0.00021, 0.00031]);
  });

  it("rolls back cost backfill across raw and every rollup tier", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-backfill-atomic"),
      turnContext("gpt-atomic"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
    ]);
    await harness.importer.syncAll();
    const aggregate = {
      cachedInputTokens: 20,
      costUsd: 0,
      inputTokens: 100,
      outputTokens: 10,
      reasoningOutputTokens: 4,
      requestCount: 1,
      totalTokens: 110,
      unpricedCachedInputTokens: 20,
      unpricedInputTokens: 100,
      unpricedOutputTokens: 10,
      unpricedUsageCount: 1,
    };
    harness.database
      .insert(usageDailyRollups)
      .values({
        ...aggregate,
        agentKind: "main",
        localDate: "2026-06-01",
        model: "gpt-atomic",
      })
      .run();
    harness.database
      .insert(usageHourlyRollups)
      .values({
        ...aggregate,
        agentKind: "main",
        localDate: "2026-06-01",
        localHour: "08:00",
        model: "gpt-atomic",
      })
      .run();
    harness.database
      .insert(usageAgentDailyRollups)
      .values({
        ...aggregate,
        agentId: "session-backfill-atomic",
        agentKind: "main",
        localDate: "2026-06-01",
        model: "gpt-atomic",
        sessionId: "session-backfill-atomic",
      })
      .run();
    upsertModelRate(harness.database, {
      cachedInputRate: 0.5,
      inputRate: 2,
      model: "gpt-atomic",
      outputRate: 4,
    });
    harness.database.run(sql`
      create trigger reject_hourly_backfill
      before update on usage_hourly_rollups
      begin
        select raise(abort, 'forced backfill failure');
      end
    `);

    expect(() => backfillUnpricedUsage(harness.database, "gpt-atomic")).toThrow();
    expect(harness.database.select().from(usageEvents).get()?.costUsd).toBeNull();
    expect(harness.database.select().from(usageDailyRollups).get()).toMatchObject({
      costUsd: 0,
      unpricedUsageCount: 1,
    });
    expect(harness.database.select().from(usageHourlyRollups).get()).toMatchObject({
      costUsd: 0,
      unpricedUsageCount: 1,
    });
    expect(harness.database.select().from(usageAgentDailyRollups).get()).toMatchObject({
      costUsd: 0,
      unpricedUsageCount: 1,
    });
  });

  it("names parent sessions and attributes child usage to individual subagents", async () => {
    const harness = await createHarness();
    upsertModelRate(harness.database, {
      cachedInputRate: 0.5,
      inputRate: 2,
      model: "gpt-parent",
      outputRate: 4,
    });
    upsertModelRate(harness.database, {
      cachedInputRate: 0.25,
      inputRate: 1,
      model: "gpt-child",
      outputRate: 2,
    });
    const parentSource = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-parent"),
      userMessage("Tạo dashboard usage theo ngày"),
      turnContext("gpt-parent"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
    ]);
    const childSource = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-parent", {
        agentId: "agent-mapper",
        depth: 1,
        name: "Mapper",
        parentThreadId: "session-parent",
        role: "explorer",
        threadSource: "subagent",
      }),
      sessionMeta("session-parent"),
      turnContext("gpt-parent"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
      taskStarted("turn-child", "2026-07-12T01:00:01.000Z"),
      turnContext("gpt-child"),
      interAgentHandoff("2026-07-12T01:00:02.000Z"),
      userMessage("Khảo sát source code dashboard"),
      tokenCount("2026-07-12T01:01:00.000Z", 200, 50, 30, 10),
    ]);

    expect((await harness.importer.syncAll()).recordsInserted).toBe(2);
    expect((await harness.importer.syncAll()).recordsInserted).toBe(0);

    const usage = harness.database.select().from(usageEvents).orderBy(usageEvents.timestamp).all();
    expect(usage.map((event) => event.agentId)).toEqual(["session-parent", "agent-mapper"]);
    expect(
      harness.database
        .select({ agentId: importStates.agentId })
        .from(importStates)
        .where(eq(importStates.sourcePath, childSource))
        .get()?.agentId,
    ).toBe("agent-mapper");
    expect(
      harness.database.select().from(sessions).where(eq(sessions.id, "session-parent")).get()
        ?.sourcePath,
    ).toBe(parentSource);

    const session = getSessions(harness.database, {
      from: "2026-07-12",
      to: "2026-07-12",
    }).sessions[0];
    expect(session).toMatchObject({
      sessionId: "session-parent",
      title: "Tạo dashboard usage theo ngày",
      totalTokens: 340,
    });
    expect(session?.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "session-parent",
          isSubagent: false,
          totalTokens: 110,
        }),
        expect.objectContaining({
          agentId: "agent-mapper",
          depth: 1,
          isSubagent: true,
          name: "Mapper",
          role: "explorer",
          taskSummary: "Khảo sát source code dashboard",
          totalTokens: 230,
        }),
      ]),
    );
  });

  it("repairs legacy subagent attribution without changing price snapshots", async () => {
    const harness = await createHarness();
    upsertModelRate(harness.database, {
      cachedInputRate: 0.25,
      inputRate: 1,
      model: "gpt-child",
      outputRate: 2,
    });
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-repair"),
      turnContext("gpt-parent"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-repair", {
        agentId: "agent-legacy",
        depth: 1,
        name: "Legacy",
        parentThreadId: "session-repair",
        threadSource: "subagent",
      }),
      sessionMeta("session-repair"),
      taskStarted("turn-repair", "2026-07-12T01:00:01.000Z"),
      turnContext("gpt-child"),
      interAgentHandoff("2026-07-12T01:00:02.000Z"),
      tokenCount("2026-07-12T01:01:00.000Z", 200, 50, 30, 10),
    ]);
    await harness.importer.syncAll();

    harness.database
      .update(usageEvents)
      .set({
        agentId: "session-repair",
        cachedInputRate: 8,
        costUsd: 42,
        inputRate: 9,
        outputRate: 10,
      })
      .where(eq(usageEvents.timestamp, "2026-07-12T01:01:00.000Z"))
      .run();
    harness.database.update(importStates).set({ dedupeVersion: 2 }).run();

    const status = await harness.importer.syncAll();
    const repaired = harness.database
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.timestamp, "2026-07-12T01:01:00.000Z"))
      .get();
    expect(status.recordsReclassified).toBeGreaterThanOrEqual(1);
    expect(repaired).toMatchObject({
      agentId: "agent-legacy",
      cachedInputRate: 8,
      costUsd: 42,
      inputRate: 9,
      outputRate: 10,
      totalTokens: 230,
    });
  });

  it("does not collapse distinct agents that report the same cumulative token snapshot", async () => {
    const harness = await createHarness();
    const cumulativeUsage = { cached: 800, input: 1_000, output: 100, reasoning: 40 };
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-mirrored"),
      turnContext("gpt-mirrored"),
      tokenCount("2026-07-11T16:50:00.000Z", 100, 20, 10, 4, cumulativeUsage),
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-mirrored", {
        agentId: "agent-replay",
        depth: 1,
        name: "Replay",
        parentThreadId: "session-mirrored",
        threadSource: "subagent",
      }),
      turnContext("gpt-mirrored"),
      tokenCount("2026-07-11T17:10:00.000Z", 100, 20, 10, 4, cumulativeUsage),
    ]);

    expect((await harness.importer.syncAll()).recordsInserted).toBe(2);
    const events = harness.database.select().from(usageEvents).all();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.agentId).sort()).toEqual([
      "agent-replay",
      "session-mirrored",
    ]);
  });

  it("retries an incomplete inherited prefix instead of advancing past its handoff", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-partial-handoff"),
      turnContext("gpt-main"),
      tokenCount("2026-07-12T01:00:00.000Z", 10, 2, 1, 0),
    ]);
    const childSource = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-partial-handoff", {
        agentId: "agent-partial",
        depth: 1,
        parentThreadId: "session-partial-handoff",
        threadSource: "subagent",
      }),
      sessionMeta("session-partial-handoff"),
      turnContext("gpt-main"),
      tokenCount("2026-07-12T01:00:00.000Z", 10, 2, 1, 0),
      taskStarted("turn-partial", "2026-07-12T01:00:30.000Z"),
      turnContext("gpt-child", "2026-07-12T01:00:31.000Z", "turn-partial"),
      tokenCount("2026-07-12T01:01:00.000Z", 20, 4, 2, 1),
    ]);

    await harness.importer.syncAll();
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
    expect(
      harness.database
        .select()
        .from(importStates)
        .where(eq(importStates.sourcePath, childSource))
        .get()?.lastOffset,
    ).toBe(0);

    await appendFile(childSource, `${interAgentHandoff("2026-07-12T01:01:01.000Z")}\n`);
    await harness.importer.syncAll();
    expect(
      harness.database
        .select()
        .from(usageEvents)
        .all()
        .map((event) => event.agentId)
        .sort(),
    ).toEqual(["agent-partial", "session-partial-handoff"]);
  });

  it("skips inherited main snapshots while preserving canonical child usage, activity, and cost", async () => {
    const harness = await createHarness();
    upsertModelRate(harness.database, {
      cachedInputRate: 0.5,
      inputRate: 2,
      model: "gpt-main",
      outputRate: 4,
    });
    upsertModelRate(harness.database, {
      cachedInputRate: 0.25,
      inputRate: 1,
      model: "gpt-subagent",
      outputRate: 2,
    });
    const mainCumulative = { cached: 20, input: 100, output: 10, reasoning: 4 };
    const childCumulative = { cached: 70, input: 300, output: 40, reasoning: 14 };
    const mainTask = taskStarted("turn-main", "2026-05-01T01:00:00.000Z");
    const mainTurn = turnContext("gpt-main", "2026-05-01T01:00:01.000Z", "turn-main");
    const mainCall = activityCall("call-main", "2026-05-01T01:00:02.000Z");
    const mainUsage = tokenCount("2026-05-01T01:00:03.000Z", 100, 20, 10, 4, mainCumulative);
    const inheritedLargeMessage = JSON.stringify({
      timestamp: "2026-05-01T01:00:04.000Z",
      type: "response_item",
      payload: { type: "message", content: "x".repeat(512 * 1024) },
    });
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-inherited"),
      mainTask,
      mainTurn,
      mainCall,
      mainUsage,
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-inherited", {
        agentId: "agent-canonical",
        depth: 1,
        name: "Canonical",
        parentThreadId: "session-inherited",
        threadSource: "subagent",
      }),
      sessionMeta("session-inherited"),
      mainTask,
      mainTurn,
      mainCall,
      mainUsage,
      inheritedLargeMessage,
      taskStarted("turn-child", "2026-05-01T01:01:00.000Z"),
      turnContext("gpt-subagent", "2026-05-01T01:01:01.000Z", "turn-child"),
      interAgentHandoff("2026-05-01T01:01:02.000Z"),
      activityCall("call-child", "2026-05-01T01:01:03.000Z"),
      tokenCount("2026-05-01T01:01:04.000Z", 200, 50, 30, 10, childCumulative),
    ]);

    expect((await harness.importer.syncAll()).recordsInserted).toBe(2);
    const usage = harness.database.select().from(usageEvents).orderBy(usageEvents.timestamp).all();
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      agentId: "session-inherited",
      costUsd: 0.00021,
      model: "gpt-main",
      totalTokens: 110,
    });
    expect(usage[1]).toMatchObject({
      agentId: "agent-canonical",
      costUsd: 0.0002225,
      model: "gpt-subagent",
      totalTokens: 230,
    });
    const activities = harness.database.select().from(activityEvents).all();
    expect(activities).toHaveLength(6);
    expect(
      Object.fromEntries(
        ["session-inherited", "agent-canonical"].map((agentId) => [
          agentId,
          activities.filter((event) => event.agentId === agentId).length,
        ]),
      ),
    ).toEqual({ "agent-canonical": 3, "session-inherited": 3 });

    harness.database.update(importStates).set({ lastOffset: 0 }).run();
    await harness.importer.syncAll();
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(2);
    expect(harness.database.select().from(activityEvents).all()).toHaveLength(6);

    const parsedMainCall = parseActivityRecord(
      JSON.parse(mainCall) as unknown,
      "session-inherited",
    );
    if (!parsedMainCall) throw new Error("Expected a parsed main activity call");
    const stableActivityId = createHash("sha256")
      .update(`session-inherited\u0000${parsedMainCall.eventHash}`)
      .digest("hex");
    const legacyActivityId = createHash("sha256")
      .update(`session-inherited\u0000${parsedMainCall.legacyEventHash}`)
      .digest("hex");
    compactUsage(harness.database, new Date("2026-07-13T00:00:00.000Z"));
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(0);
    expect(harness.database.select().from(activityEvents).all()).toHaveLength(0);
    harness.database
      .delete(archivedActivityEventIds)
      .where(eq(archivedActivityEventIds.id, stableActivityId))
      .run();
    harness.database
      .insert(archivedActivityEventIds)
      .values({ archivedAt: Date.now(), id: legacyActivityId })
      .onConflictDoNothing()
      .run();
    harness.database.update(importStates).set({ lastOffset: 0 }).run();
    await harness.importer.syncAll();
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(0);
    expect(harness.database.select().from(activityEvents).all()).toHaveLength(0);
    expect(
      harness.database
        .select()
        .from(archivedActivityEventIds)
        .where(eq(archivedActivityEventIds.id, stableActivityId))
        .get(),
    ).toBeTruthy();
    expect(
      harness.database
        .select({ total: sql<number>`sum(${usageDailyRollups.totalTokens})` })
        .from(usageDailyRollups)
        .get()?.total,
    ).toBe(340);
  });

  it("attributes nested subagents to their own models without overwriting the main workspace", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-nested", { cwd: "/workspace/main" }),
      turnContext("gpt-main"),
      tokenCount("2026-07-12T01:00:00.000Z", 10, 2, 1, 0),
    ]);
    await harness.importer.syncAll();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-nested", {
        agentId: "agent-child",
        cwd: "/workspace/child",
        depth: 1,
        parentThreadId: "session-nested",
        threadSource: "subagent",
      }),
      turnContext("gpt-child"),
      tokenCount("2026-07-12T01:01:00.000Z", 20, 4, 2, 1),
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-nested", {
        agentId: "agent-grandchild",
        cwd: "/workspace/grandchild",
        depth: 2,
        parentThreadId: "agent-child",
        threadSource: "subagent",
      }),
      sessionMeta("session-nested", {
        agentId: "agent-child",
        depth: 1,
        parentThreadId: "session-nested",
        threadSource: "subagent",
      }),
      turnContext("gpt-child"),
      tokenCount("2026-07-12T01:01:00.000Z", 20, 4, 2, 1),
      taskStarted("turn-grandchild", "2026-07-12T01:01:30.000Z"),
      turnContext("gpt-grandchild", "2026-07-12T01:01:31.000Z", "turn-grandchild"),
      interAgentHandoff("2026-07-12T01:01:32.000Z"),
      tokenCount("2026-07-12T01:02:00.000Z", 30, 6, 3, 1),
    ]);

    await harness.importer.syncAll();
    const usage = harness.database.select().from(usageEvents).all();
    expect(usage).toHaveLength(3);
    expect(
      usage
        .map(({ agentId, model, totalTokens }) => ({ agentId, model, totalTokens }))
        .sort((left, right) => left.agentId.localeCompare(right.agentId)),
    ).toEqual([
      { agentId: "agent-child", model: "gpt-child", totalTokens: 22 },
      { agentId: "agent-grandchild", model: "gpt-grandchild", totalTokens: 33 },
      { agentId: "session-nested", model: "gpt-main", totalTokens: 11 },
    ]);
    expect(
      harness.database
        .select()
        .from(sessionAgents)
        .where(eq(sessionAgents.id, "agent-grandchild"))
        .get(),
    ).toMatchObject({ depth: 2, parentThreadId: "agent-child" });
    expect(
      harness.database.select().from(sessions).where(eq(sessions.id, "session-nested")).get(),
    ).toMatchObject({ cwd: "/workspace/main" });

    const filteredAgents = getSessions(harness.database, {
      from: "2026-07-12",
      models: ["gpt-grandchild"],
      to: "2026-07-12",
    }).sessions[0]?.agents;
    expect(filteredAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "session-nested",
          lastEventAt: null,
          totalTokens: 0,
        }),
        expect.objectContaining({
          agentId: "agent-child",
          lastEventAt: null,
          parentAgentId: "session-nested",
          totalTokens: 0,
        }),
        expect.objectContaining({
          agentId: "agent-grandchild",
          parentAgentId: "agent-child",
          totalTokens: 33,
        }),
      ]),
    );
  });

  it("restores the last activity timestamp when attributing archived activity", async () => {
    const harness = await createHarness();
    const shellCall = activityCall("call-archived-late", "2026-05-01T01:00:05.000Z");
    const source = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-archived-activity"),
      taskStarted("turn-archived-activity", "2026-05-01T01:00:00.000Z"),
      turnContext("gpt-archived", "2026-05-01T01:00:01.000Z", "turn-archived-activity"),
      tokenCount("2026-05-01T01:00:02.000Z", 10, 2, 1, 0),
      shellCall,
    ]);
    await harness.importer.syncAll();
    const turnKey = createTurnKey("session-archived-activity", "turn-archived-activity");
    const parsedCall = parseActivityRecord(
      JSON.parse(shellCall) as unknown,
      "session-archived-activity",
    );
    if (!parsedCall) throw new Error("Expected archived shell activity metadata");
    const activityId = createHash("sha256")
      .update(`session-archived-activity\u0000${parsedCall.eventHash}`)
      .digest("hex");

    compactUsage(harness.database, new Date("2026-07-13T00:00:00.000Z"));
    harness.database
      .update(archivedActivityEventIds)
      .set({ turnAttributionVersion: 0, turnKey: null })
      .where(eq(archivedActivityEventIds.id, activityId))
      .run();
    harness.database
      .delete(turnActivityRollups)
      .where(and(eq(turnActivityRollups.turnKey, turnKey), eq(turnActivityRollups.kind, "shell")))
      .run();
    harness.database
      .update(turns)
      .set({ lastEventAt: "2026-05-01T01:00:02.000Z" })
      .where(eq(turns.id, turnKey))
      .run();
    harness.database
      .update(importStates)
      .set({ lastOffset: 0, turnAttributionVersion: 0 })
      .where(eq(importStates.sourcePath, source))
      .run();

    expect((await harness.importer.syncAll()).error).toBeNull();
    expect(harness.database.select().from(turns).where(eq(turns.id, turnKey)).get()).toMatchObject({
      lastEventAt: "2026-05-01T01:00:05.000Z",
    });
    expect(
      harness.database
        .select()
        .from(turnActivityRollups)
        .where(and(eq(turnActivityRollups.turnKey, turnKey), eq(turnActivityRollups.kind, "shell")))
        .get(),
    ).toMatchObject({ eventCount: 1 });
  });

  it("uses the newest Codex session-index title instead of a prompt-derived fallback", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-indexed"),
      userMessage("Tên lấy từ prompt này không phải title chuẩn"),
      turnContext("gpt-indexed"),
      tokenCount("2026-07-12T01:00:00.000Z", 10, 0, 2, 0),
    ]);
    await writeFile(
      join(harness.sessionsDirectory, "..", "session_index.jsonl"),
      [
        JSON.stringify({
          id: "session-indexed",
          thread_name: "Tên cũ",
          updated_at: "2026-07-12T00:00:00.000Z",
        }),
        JSON.stringify({
          id: "session-indexed",
          thread_name: "Tên task chuẩn trong Codex",
          updated_at: "2026-07-12T01:00:00.000Z",
        }),
      ].join("\n"),
    );

    await harness.importer.syncAll();
    expect(
      getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" }).sessions[0]?.title,
    ).toBe("Tên task chuẩn trong Codex");
  });

  it("streams session-index appends, retains partial tails and rebuilds after rewrite", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-streamed-index"),
      userMessage("Fallback title"),
      turnContext("gpt-indexed"),
      tokenCount("2026-07-12T01:00:00.000Z", 10, 0, 2, 0),
    ]);
    const indexPath = join(harness.sessionsDirectory, "..", "session_index.jsonl");
    const indexedTitle = (title: string, updatedAt: string) =>
      JSON.stringify({ id: "session-streamed-index", thread_name: title, updated_at: updatedAt });
    await writeFile(indexPath, indexedTitle("Title newest", "2026-07-12T02:00:00.000Z"));
    await harness.importer.syncAll();

    await appendFile(indexPath, `\n${indexedTitle("Title older", "2026-07-12T01:00:00.000Z")}`);
    await harness.importer.syncAll();
    expect(
      getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" }).sessions[0]?.title,
    ).toBe("Title newest");

    const newest = indexedTitle("Title after partial", "2026-07-12T03:00:00.000Z");
    const splitAt = Math.floor(newest.length / 2);
    await appendFile(indexPath, `\n${newest.slice(0, splitAt)}`);
    await harness.importer.syncAll();
    expect(
      getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" }).sessions[0]?.title,
    ).toBe("Title newest");
    await appendFile(indexPath, newest.slice(splitAt));
    await harness.importer.syncAll();
    expect(
      getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" }).sessions[0]?.title,
    ).toBe("Title after partial");

    await writeFile(indexPath, indexedTitle("Title rebuilt", "2026-07-12T04:00:00.000Z"));
    await harness.importer.syncAll();
    expect(
      getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" }).sessions[0]?.title,
    ).toBe("Title rebuilt");
  });

  it("watches Codex session-index changes and refreshes titles", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-watched-index"),
      userMessage("Fallback title"),
      turnContext("gpt-indexed"),
      tokenCount("2026-07-12T01:00:00.000Z", 10, 0, 2, 0),
    ]);
    const indexPath = join(harness.sessionsDirectory, "..", "session_index.jsonl");

    await harness.importer.start();
    await harness.importer.syncAll();
    await writeFile(
      indexPath,
      JSON.stringify({
        id: "session-watched-index",
        thread_name: "Tên đổi trong Codex",
        updated_at: "2026-07-12T01:00:00.000Z",
      }),
    );
    await vi.waitFor(
      () => {
        expect(
          getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" }).sessions[0]
            ?.title,
        ).toBe("Tên đổi trong Codex");
        expect(harness.importer.getStatus().filesProcessed).toBe(0);
      },
      { interval: 50, timeout: 3_000 },
    );
    await harness.importer.stop();
  });

  it("marks watcher unlinks immediately and restores the source without duplicating history", async () => {
    const harness = await createHarness();
    const lines = [
      sessionMeta("session-watched-source"),
      turnContext("gpt-watched-source"),
      tokenCount("2026-07-12T01:00:00.000Z", 10, 0, 2, 0),
    ];
    const source = await createSessionFile(harness.sessionsDirectory, lines);
    await harness.importer.syncAll();
    await harness.importer.start();

    await rm(source);
    await vi.waitFor(
      () =>
        expect(
          harness.database
            .select()
            .from(sessions)
            .where(eq(sessions.id, "session-watched-source"))
            .get(),
        ).toMatchObject({ sourceDeleted: true }),
      { interval: 50, timeout: 3_000 },
    );

    await writeFile(source, `${lines.join("\n")}\n`);
    await vi.waitFor(
      () =>
        expect(
          harness.database
            .select()
            .from(sessions)
            .where(eq(sessions.id, "session-watched-source"))
            .get(),
        ).toMatchObject({ sourceDeleted: false }),
      { interval: 50, timeout: 3_000 },
    );
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
    await harness.importer.stop();
  });

  it("aggregates dashboard data and validates API inputs", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-api"),
      turnContext("gpt-api"),
      tokenCount("2026-07-12T02:00:00.000Z", 200, 50, 25, 10),
    ]);
    upsertModelRate(harness.database, {
      cachedInputRate: 0.4,
      inputRate: 2,
      model: "gpt-api",
      outputRate: 3,
    });
    await harness.importer.syncAll();

    const dashboard = getDashboard(harness.database, { from: "2026-07-12", to: "2026-07-12" });
    expect(dashboard.kpis).toMatchObject({
      inputTokens: 200,
      outputTokens: 25,
      requestCount: 1,
      sessionCount: 1,
      totalTokens: 225,
      unpricedUsageCount: 0,
    });
    expect(dashboard.models[0]?.model).toBe("gpt-api");
    expect(dashboard.models[0]?.tokenShare).toBe(1);
    expect(dashboard.dailyModels).toEqual([
      {
        date: "2026-07-12",
        estimatedCostUsd: 0.000395,
        model: "gpt-api",
        requestCount: 1,
        totalTokens: 225,
      },
    ]);
    expect(dashboard.hourly).toHaveLength(24);
    expect(dashboard.hourly.find((hour) => hour.hour === "09:00")).toMatchObject({
      requestCount: 1,
      totalTokens: 225,
    });
    expect(dashboard.hourlyModels).toEqual([
      {
        estimatedCostUsd: 0.000395,
        hour: "09:00",
        model: "gpt-api",
        requestCount: 1,
        totalTokens: 225,
      },
    ]);
    expect(
      getDashboard(harness.database, { from: "2026-07-11", to: "2026-07-12" }).hourlyModels,
    ).toEqual([]);
    expect(
      getDashboard(harness.database, { from: "2026-07-13", model: "missing", to: "2026-07-13" })
        .kpis.totalTokens,
    ).toBe(0);
    expect(
      getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" }).sessions[0],
    ).toMatchObject({
      models: ["gpt-api"],
      sessionId: "session-api",
      sourceDeleted: false,
    });
    upsertModelRate(harness.database, {
      cachedInputRate: 0,
      inputRate: 1,
      model: "rate-only",
      outputRate: 1,
    });
    expect(getKnownModels(harness.database)).toEqual(["gpt-api", "rate-only"]);
    expect(getModelRates(harness.database).map((rate) => rate.model)).toEqual([
      "gpt-api",
      "rate-only",
    ]);
    expect(backfillUnpricedUsage(harness.database, "missing-rate")).toBe(0);

    const app = createApp(harness.database, harness.importer, harness.retention);
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/status")).status).toBe(200);
    expect((await app.request("/api/storage/status")).status).toBe(200);
    expect((await app.request("/api/storage/compact", { method: "POST" })).status).toBe(200);
    expect((await app.request("/api/dashboard")).status).toBe(200);
    expect((await app.request("/api/models")).status).toBe(200);
    expect((await app.request("/api/rates")).status).toBe(200);
    expect((await app.request("/api/sessions?from=2026-07-12&to=2026-07-12")).status).toBe(200);
    const syncResponse = await app.request("/api/sync", { method: "POST" });
    expect(syncResponse.status).toBe(200);
    expect((await syncResponse.json()) as ImportStatus).toMatchObject({
      error: null,
      sourceScan: { lastCompleted: { mode: "inventory" } },
    });
    expect((await app.request("/api/dashboard?from=bad&to=2026-07-12")).status).toBe(400);
    expect(
      (
        await app.request("/api/rates/gpt-api", {
          body: JSON.stringify({ inputRate: -1 }),
          method: "PUT",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/rates/%20", {
          body: JSON.stringify({ cachedInputRate: 1, inputRate: 1, outputRate: 1 }),
          method: "PUT",
        })
      ).status,
    ).toBe(400);
    const validRate = await app.request("/api/rates/gpt-api", {
      body: JSON.stringify({ cachedInputRate: 1, inputRate: 2, outputRate: 3 }),
      method: "PUT",
    });
    expect(validRate.status).toBe(200);
    expect(
      (
        await app.request("/api/rates/gpt-api", {
          body: "{",
          headers: { "content-type": "application/json" },
          method: "PUT",
        })
      ).status,
    ).toBe(400);
    expect((await app.request("/api/dashboard?from=2026-02-30&to=2026-03-01")).status).toBe(400);
    expect((await app.request("/api/rates/%20/backfill", { method: "POST" })).status).toBe(400);
    expect((await app.request("/api/rates/gpt-api/backfill", { method: "POST" })).status).toBe(200);
  });

  it("serves scan telemetry and accepts only one queued deep verification", async () => {
    let sourcePath = "";
    let scanAttempts = 0;
    let releaseDeep: (() => void) | undefined;
    let markDeepStarted: (() => void) | undefined;
    const deepGate = new Promise<void>((resolve) => {
      releaseDeep = resolve;
    });
    const deepStarted = new Promise<void>((resolve) => {
      markDeepStarted = resolve;
    });
    const scanner: SourceInventoryScanner = async () => {
      scanAttempts += 1;
      if (scanAttempts === 2) {
        markDeepStarted?.();
        await deepGate;
      }
      const metadata = sourcePath ? await readSourceFileMetadata(sourcePath) : null;
      return {
        files: metadata ? [metadata] : [],
        sourceBytes: metadata?.size ?? 0,
      };
    };
    const harness = await createHarness({
      createInventory: (directory) => new SourceInventory(directory, () => new Date(), 32, scanner),
    });
    sourcePath = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-deep-api"),
      turnContext("gpt-deep"),
      tokenCount("2026-07-12T02:00:00.000Z", 20, 5, 2, 1),
    ]);
    await harness.importer.syncAll();
    const app = createApp(harness.database, harness.importer, harness.retention);

    const accepted = await app.request("/api/sync/deep", { method: "POST" });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({ accepted: true });
    await deepStarted;

    const duplicate = await app.request("/api/sync/deep", { method: "POST" });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      error: "Deep verification is already queued or running",
    });

    const importStatus = (await (await app.request("/api/status")).json()) as ImportStatus;
    const dataHealth = (await (await app.request("/api/data-health")).json()) as DataHealthResponse;
    const storage = (await (await app.request("/api/storage/status")).json()) as StorageStatus;
    expect(importStatus.sourceScan.current).toMatchObject({ mode: "deep", trigger: "manual" });
    expect(dataHealth.sourceScan.current).toMatchObject({ mode: "deep" });
    expect(storage).toMatchObject({
      sourceFileCount: 1,
      sourceScannedAt: expect.any(String),
    });
    expect(JSON.stringify({ dataHealth, importStatus, storage })).not.toContain(sourcePath);

    releaseDeep?.();
    await vi.waitFor(
      () =>
        expect(harness.importer.getStatus().sourceScan.lastCompleted).toMatchObject({
          filesRead: 1,
          filesSkipped: 0,
          mode: "deep",
        }),
      { interval: 10, timeout: 2_000 },
    );
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
    await harness.importer.stop();
  });

  it("compacts raw usage into exact hourly and daily retention tiers", async () => {
    const harness = await createHarness();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const hourlySource = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-hourly", {
        agentId: "agent-hourly",
        parentThreadId: "session-hourly",
        threadSource: "subagent",
      }),
      turnContext("gpt-retained"),
      tokenCount("2026-06-13T02:00:00.000Z", 100, 20, 10, 4),
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-raw"),
      turnContext("gpt-retained"),
      tokenCount("2026-06-14T02:00:00.000Z", 100, 20, 10, 4),
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-hourly-edge"),
      turnContext("gpt-retained"),
      tokenCount("2026-04-15T02:00:00.000Z", 100, 20, 10, 4),
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-daily"),
      turnContext("gpt-retained"),
      tokenCount("2026-04-14T02:00:00.000Z", 100, 20, 10, 4),
    ]);
    await harness.importer.syncAll();
    const retainedProjectId = harness.database
      .select({ projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, "session-hourly-edge"))
      .get()?.projectId;
    expect(retainedProjectId).toBeTruthy();
    if (!retainedProjectId) throw new Error("Expected retained session project");

    expect(compactUsage(harness.database, now)).toMatchObject({
      hourlyRowsDeleted: 2,
      rawEventsDeleted: 3,
      rollupRowsWritten: 9,
    });
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
    expect(harness.database.select().from(usageHourlyRollups).all()).toHaveLength(2);
    expect(harness.database.select().from(usageDailyRollups).all()).toHaveLength(3);
    expect(harness.database.select().from(usageAgentDailyRollups).all()).toHaveLength(3);
    expect(harness.database.select().from(archivedUsageEventIds).all()).toHaveLength(3);
    expect(
      harness.database
        .select()
        .from(usageDailyRollups)
        .where(eq(usageDailyRollups.localDate, "2026-06-13"))
        .get(),
    ).toMatchObject({ agentKind: "subagent", totalTokens: 110 });

    const dashboard = getDashboard(harness.database, { from: "2026-04-14", to: "2026-06-14" }, now);
    expect(dashboard.kpis).toMatchObject({
      requestCount: 4,
      sessionCount: 4,
      totalTokens: 440,
      unpricedUsageCount: 4,
    });
    expect(
      getDashboard(harness.database, { from: "2026-04-15", to: "2026-04-15" }, now).hourly.find(
        (hour) => hour.hour === "09:00",
      ),
    ).toMatchObject({ sessionCount: 1, totalTokens: 110 });
    expect(
      getDashboard(
        harness.database,
        {
          from: "2026-04-15",
          projectId: retainedProjectId,
          to: "2026-04-15",
        },
        now,
      ).kpis,
    ).toMatchObject({ sessionCount: 1, totalTokens: 110 });
    expect(
      getDashboard(
        harness.database,
        { from: "2026-04-15", projectId: "legacy-unknown", to: "2026-04-15" },
        now,
      ).kpis,
    ).toMatchObject({ sessionCount: 0, totalTokens: 0 });
    expect(
      getDashboard(harness.database, { from: "2026-04-14", to: "2026-04-14" }, now),
    ).toMatchObject({ hourly: [], retention: { hourlyAvailable: false } });
    expect(
      getSessions(harness.database, { from: "2026-04-14", to: "2026-06-14" }, now),
    ).toMatchObject({ coverage: { from: "2026-06-14", status: "partial" } });

    expect(compactUsage(harness.database, now)).toEqual({
      hourlyRowsDeleted: 0,
      rawEventsDeleted: 0,
      rollupRowsWritten: 0,
    });
    harness.database.update(importStates).set({ lastOffset: 0 }).run();
    expect((await harness.importer.syncAll()).recordsInserted).toBe(0);

    await appendFile(hourlySource, `${tokenCount("2026-06-13T03:00:00.000Z", 50, 10, 5, 2)}\n`);
    expect((await harness.importer.syncAll()).recordsInserted).toBe(1);
    expect(compactUsage(harness.database, now).rawEventsDeleted).toBe(1);
    expect(
      getDashboard(harness.database, { from: "2026-06-13", to: "2026-06-13" }, now).kpis,
    ).toMatchObject({ sessionCount: 1, totalTokens: 165, unpricedUsageCount: 2 });

    upsertModelRate(harness.database, {
      cachedInputRate: 0.5,
      inputRate: 2,
      model: "gpt-retained",
      outputRate: 4,
    });
    expect(backfillUnpricedUsage(harness.database, "gpt-retained")).toBeGreaterThan(0);
    expect(
      getDashboard(harness.database, { from: "2026-04-14", to: "2026-06-14" }, now).kpis,
    ).toMatchObject({ totalTokens: 495, unpricedUsageCount: 0 });
    expect(
      harness.database
        .select()
        .from(usageRollupSessionMemberships)
        .where(eq(usageRollupSessionMemberships.bucketType, "day"))
        .all(),
    ).toHaveLength(3);
  });

  it("rolls back retention atomically and reports a compaction error", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-retention-failure"),
      turnContext("gpt-failure"),
      tokenCount("2026-05-01T02:00:00.000Z", 100, 20, 10, 4),
    ]);
    await harness.importer.syncAll();
    harness.database.run(sql`
      create trigger reject_daily_rollup
      before insert on usage_daily_rollups
      begin
        select raise(abort, 'forced retention failure');
      end
    `);

    const status = await harness.retention.compact();
    expect(status.error).toContain("forced retention failure");
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
    expect(harness.database.select().from(usageHourlyRollups).all()).toHaveLength(0);
    expect(harness.database.select().from(usageDailyRollups).all()).toHaveLength(0);
  });

  it("reports storage paths and keeps scheduled compaction single-instance", async () => {
    const harness = await createHarness();
    const missingInventory = new SourceInventory(join(harness.sessionsDirectory, "missing-source"));
    const missing = new RetentionService(
      harness.database,
      join(harness.sessionsDirectory, "missing.db"),
      join(harness.sessionsDirectory, "missing-source"),
      () => new Date(),
      missingInventory,
    );
    const missingStatus = await missing.getStatus();
    expect(missingStatus).toMatchObject({
      databaseBytes: 0,
      oldestRawDate: null,
      sourceBytes: 0,
      sourceFileCount: 0,
      sourceScannedAt: null,
      walBytes: 0,
    });
    expect(missingInventory.getScanCount()).toBe(0);

    const source = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-storage-cache"),
      turnContext("gpt-storage"),
      tokenCount("2026-07-12T01:00:00.000Z", 10, 0, 2, 0),
    ]);
    const notePath = join(harness.sessionsDirectory, "note.txt");
    await writeFile(notePath, "inventory bytes");
    await harness.importer.syncAll();
    const scansBeforeStatus = harness.inventory.getScanCount();
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () => harness.retention.getStatus()),
    );
    expect(harness.inventory.getScanCount()).toBe(scansBeforeStatus);
    expect(statuses[0]).toMatchObject({
      sourceBytes: (await stat(source)).size + (await stat(notePath)).size,
      sourceFileCount: 1,
      sourceScannedAt: expect.any(String),
    });

    await symlink(harness.sessionsDirectory, join(harness.sessionsDirectory, "ignored-link"));
    const [first, second] = await Promise.all([
      harness.retention.compact(),
      harness.retention.compact(),
    ]);
    expect(first.error).toBeNull();
    expect(second.policy).toEqual({ dailyRetention: "forever", hourlyDays: 90, rawDays: 30 });

    vi.useFakeTimers();
    harness.retention.start();
    harness.retention.start();
    harness.retention.stop();
    harness.retention.stop();
    vi.useRealTimers();
  });

  it("skips malformed or incomplete records and reports individual file errors", async () => {
    const harness = await createHarness();
    const source = await createSessionFile(harness.sessionsDirectory, [
      "not-json",
      JSON.stringify({ type: "session_meta", payload: {} }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      sessionMeta("session-unknown"),
      JSON.stringify({ type: "turn_context", payload: {} }),
      JSON.stringify({
        type: "event_msg",
        payload: { info: { last_token_usage: { input_tokens: 1 } }, type: "token_count" },
        timestamp: "2026-07-12T03:00:00.000Z",
      }),
      tokenCount("invalid", 2, 0, 1, 0),
      tokenCount("2026-07-12T03:01:00.000Z", 2, 0, 1, 0),
    ]);

    await harness.importer.syncAll();
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
    expect(harness.database.select().from(usageEvents).get()?.model).toBe("unknown");
    expect(
      await harness.importer.syncFile(join(harness.sessionsDirectory, "not-found.jsonl")),
    ).toBe(0);
    expect(harness.importer.getStatus().error).toContain("ENOENT");

    await harness.importer.start();
    await harness.importer.start();
    await harness.importer.stop();
    await appendFile(source, "\n");
  });

  it("streams oversized compaction payloads while preserving activity and incomplete cursors", async () => {
    const harness = await createHarness();
    const oversizedPayload = "x".repeat(512 * 1024);
    const completeCompaction = JSON.stringify({
      timestamp: "2026-07-12T03:00:01.000Z",
      type: "compacted",
      payload: { replacement_history: oversizedPayload },
    });
    const source = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-large-compaction"),
      turnContext("gpt-large"),
      tokenCount("2026-07-12T03:00:00.000Z", 10, 2, 1, 0),
      completeCompaction,
      tokenCount("2026-07-12T03:00:02.000Z", 20, 4, 2, 1),
    ]);

    await harness.importer.syncAll();
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(2);
    expect(
      harness.database
        .select()
        .from(activityEvents)
        .all()
        .filter((event) => event.kind === "compaction"),
    ).toHaveLength(1);
    const completeOffset = harness.database
      .select()
      .from(importStates)
      .where(eq(importStates.sourcePath, source))
      .get()?.lastOffset;

    const incompleteCompaction = JSON.stringify({
      timestamp: "2026-07-12T03:00:03.000Z",
      type: "compacted",
      payload: { replacement_history: oversizedPayload },
    }).slice(0, -1);
    await appendFile(source, incompleteCompaction);
    await harness.importer.syncAll();
    expect(
      harness.database.select().from(importStates).where(eq(importStates.sourcePath, source)).get()
        ?.lastOffset,
    ).toBe(completeOffset);
    expect(
      harness.database
        .select()
        .from(importDiagnostics)
        .where(eq(importDiagnostics.sourcePath, source))
        .get()?.incompleteLine,
    ).toBe(true);

    await appendFile(source, "}\n");
    await harness.importer.syncAll();
    expect(
      harness.database
        .select()
        .from(activityEvents)
        .all()
        .filter((event) => event.kind === "compaction"),
    ).toHaveLength(2);
    expect(
      harness.database
        .select()
        .from(importDiagnostics)
        .where(eq(importDiagnostics.sourcePath, source))
        .get(),
    ).toMatchObject({ incompleteLine: false, malformedLines: 0 });

    const balancedInvalidCompaction = `{"timestamp":"2026-07-12T03:00:04.000Z","type":"compacted","payload":{"replacement_history":"${oversizedPayload}","invalid":truX}}`;
    await appendFile(source, `${balancedInvalidCompaction}\n`);
    await harness.importer.syncAll();
    expect(
      harness.database
        .select()
        .from(activityEvents)
        .all()
        .filter((event) => event.kind === "compaction"),
    ).toHaveLength(2);
    expect(
      harness.database
        .select()
        .from(importDiagnostics)
        .where(eq(importDiagnostics.sourcePath, source))
        .get(),
    ).toMatchObject({ incompleteLine: false, malformedLines: 1 });

    const reorderedTokenCount = JSON.stringify({
      timestamp: "2026-07-12T03:00:05.000Z",
      type: "event_msg",
      payload: {
        decoy: { type: "message" },
        type: "token_count",
        info: {
          last_token_usage: {
            cached_input_tokens: 6,
            input_tokens: 30,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 33,
          },
        },
        padding: oversizedPayload,
      },
    });
    await appendFile(source, `${reorderedTokenCount}\n`);
    await harness.importer.syncAll();
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(3);
    expect(
      harness.database
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.timestamp, "2026-07-12T03:00:05.000Z"))
        .get(),
    ).toMatchObject({ cachedInputTokens: 6, model: "gpt-large", totalTokens: 33 });

    await appendFile(
      source,
      `${[
        taskStarted("turn-large-patch", "2026-07-12T03:00:05.100Z"),
        turnContext("gpt-large", "2026-07-12T03:00:05.200Z", "turn-large-patch"),
        taskStarted("turn-active-after-patch", "2026-07-12T03:00:05.300Z"),
        turnContext("gpt-large", "2026-07-12T03:00:05.400Z", "turn-active-after-patch"),
      ].join("\n")}\n`,
    );
    await harness.importer.syncAll();

    const largePatch = JSON.stringify({
      timestamp: "2026-07-12T03:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "call-large-patch",
        turn_id: "turn-large-patch",
        stdout: oversizedPayload,
      },
    });
    const parsedPatch = parseActivityRecord(
      JSON.parse(largePatch) as unknown,
      "session-large-compaction",
    );
    if (!parsedPatch) throw new Error("Expected the oversized patch to produce activity metadata");
    await appendFile(source, `${largePatch}\n`);
    await harness.importer.syncAll();
    const projectedPatchId = createHash("sha256")
      .update(`session-large-compaction\u0000${parsedPatch.eventHash}`)
      .digest("hex");
    expect(
      harness.database
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.id, projectedPatchId))
        .get(),
    ).toMatchObject({
      kind: "patch",
      timestamp: "2026-07-12T03:00:06.000Z",
      turnKey: createTurnKey("session-large-compaction", "turn-large-patch"),
    });
    expect(
      harness.database.select().from(importStates).where(eq(importStates.sourcePath, source)).get()
        ?.lastOffset,
    ).toBe((await stat(source)).size);
  });

  it("validates the complete JSON grammar for projected records with bounded nesting", async () => {
    const harness = await createHarness();
    const padding = "x".repeat(10 * 1024);
    const validCompaction = JSON.stringify({
      timestamp: "2026-07-12T03:10:00.000Z",
      type: "compacted",
      payload: {
        padding,
        nested: {
          emptyObject: {},
          emptyArray: [],
          values: [true, false, null, 0, -1, 12, 1.5, 1e3, -2.5e-2],
          escaped: 'quote:" slash:/ backslash:\\ controls:\b\f\n\r\t unicode:A',
        },
      },
    });
    const invalidPrefix = `{"timestamp":"2026-07-12T03:10:01.000Z","type":"compacted","payload":{"padding":"${padding}",`;
    const invalidLines = [
      `${invalidPrefix}"bad":truX}}`,
      `${invalidPrefix}"bad":01}}`,
      `${invalidPrefix}"bad":-x}}`,
      `${invalidPrefix}"bad":1.}}`,
      `${invalidPrefix}"bad":1e}}`,
      `${invalidPrefix}"bad":1e+}}`,
      `${invalidPrefix}"bad":"\\q"}}`,
      `${invalidPrefix}"bad":"\\uZZZQ"}}`,
      `${invalidPrefix}"bad":{"x" 1}}}`,
      `${invalidPrefix}"bad":{"x":1 "y":2}}}`,
      `${invalidPrefix}"bad":{"x":}}}`,
      `${invalidPrefix}"bad":{"x":1,}}}`,
      `${invalidPrefix}"bad":[1 2]}}`,
      `${invalidPrefix}"bad":[1,]}}`,
      `${invalidPrefix}"bad":[}}`,
      `${invalidPrefix}"bad":${"[".repeat(257)}0${"]".repeat(257)}}}`,
      `${invalidPrefix}"bad":true}} trailing`,
    ];
    const source = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-projected-grammar"),
      validCompaction,
      ...invalidLines,
    ]);

    await harness.importer.syncAll();
    expect(
      harness.database
        .select()
        .from(activityEvents)
        .all()
        .filter((event) => event.kind === "compaction"),
    ).toHaveLength(1);
    expect(
      harness.database
        .select()
        .from(importDiagnostics)
        .where(eq(importDiagnostics.sourcePath, source))
        .get(),
    ).toMatchObject({ incompleteLine: false, malformedLines: invalidLines.length });
    expect(
      harness.database.select().from(importStates).where(eq(importStates.sourcePath, source)).get()
        ?.lastOffset,
    ).toBe((await stat(source)).size);
  });

  it("treats a missing sessions root as an empty source", async () => {
    const harness = await createHarness();
    const missing = new SessionImporter(
      harness.database,
      join(harness.sessionsDirectory, "does-not-exist"),
    );
    await expect(missing.syncAll()).resolves.toMatchObject({ error: null, filesProcessed: 0 });
  });

  it("drains an in-flight import before stop resolves", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-stop-drain"),
      turnContext("gpt-stop"),
      tokenCount("2026-07-12T03:00:00.000Z", 10, 2, 1, 0),
    ]);

    const syncing = harness.importer.syncAll();
    await harness.importer.stop();

    await expect(syncing).resolves.toMatchObject({ error: null, recordsInserted: 1 });
    expect(harness.importer.getStatus().isSyncing).toBe(false);
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
  });

  it("reconciles unknown models within the same canonical agent", async () => {
    const harness = await createHarness();
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-agent-model"),
      turnContext("gpt-main", "2026-07-12T02:59:00.000Z"),
      tokenCount("2026-07-12T03:00:00.000Z", 100, 20, 10, 4),
      tokenCount("2026-07-12T04:00:00.000Z", 100, 20, 10, 4),
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-agent-model", {
        agentId: "agent-model-child",
        depth: 1,
        parentThreadId: "session-agent-model",
        threadSource: "subagent",
      }),
      turnContext("gpt-subagent", "2026-07-12T04:00:00.500Z"),
      tokenCount("2026-07-12T04:00:01.000Z", 100, 20, 10, 4),
    ]);
    await harness.importer.syncAll();
    harness.database
      .update(usageEvents)
      .set({ model: "unknown" })
      .where(eq(usageEvents.timestamp, "2026-07-12T04:00:00.000Z"))
      .run();

    expect(reconcileUnknownModels(harness.database)).toBe(1);
    expect(
      harness.database
        .select({ agentId: usageEvents.agentId, model: usageEvents.model })
        .from(usageEvents)
        .where(eq(usageEvents.timestamp, "2026-07-12T04:00:00.000Z"))
        .get(),
    ).toEqual({ agentId: "session-agent-model", model: "gpt-main" });
  });

  it("reclassifies an inferred model and backfills its existing rate during sync", async () => {
    const harness = await createHarness();
    upsertModelRate(harness.database, {
      cachedInputRate: 0.5,
      inputRate: 2,
      model: "gpt-reconciled",
      outputRate: 4,
    });
    const sourcePath = await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-reconciled"),
      turnContext("gpt-reconciled", "2026-07-12T03:59:00.000Z", "turn-reconciled"),
      tokenCount("2026-07-12T04:00:00.000Z", 100, 20, 10, 4),
      tokenCount("2026-07-12T04:01:00.000Z", 100, 20, 10, 4),
    ]);
    await harness.importer.syncAll();
    harness.database
      .update(usageEvents)
      .set({
        cachedInputRate: null,
        costUsd: null,
        inputRate: null,
        model: "unknown",
        outputRate: null,
      })
      .where(eq(usageEvents.timestamp, "2026-07-12T04:00:00.000Z"))
      .run();
    await appendFile(sourcePath, "\n");
    const turnKey = createTurnKey("session-reconciled", "turn-reconciled");
    harness.database
      .update(turnModelUsage)
      .set({
        cachedInputTokens: 20,
        costUsd: 0.00021,
        inputTokens: 100,
        outputTokens: 10,
        reasoningOutputTokens: 4,
        requestCount: 1,
        totalTokens: 110,
      })
      .where(eq(turnModelUsage.turnKey, turnKey))
      .run();
    harness.database
      .insert(turnModelUsage)
      .values({
        cachedInputTokens: 20,
        costAttributionMissingCount: 0,
        costUsd: 0,
        inputTokens: 100,
        model: "unknown",
        outputTokens: 10,
        reasoningOutputTokens: 4,
        requestCount: 1,
        totalTokens: 110,
        turnKey,
        unpricedCachedInputTokens: 20,
        unpricedInputTokens: 100,
        unpricedOutputTokens: 10,
        unpricedUsageCount: 1,
      })
      .run();

    const status = await harness.importer.syncAll();
    const event = harness.database
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.sessionId, "session-reconciled"))
      .get();
    expect(status).toMatchObject({ recordsBackfilled: 2, recordsReclassified: 1 });
    expect(event).toMatchObject({ costUsd: 0.00021, model: "gpt-reconciled" });
    expect(
      harness.database
        .select()
        .from(turnModelUsage)
        .where(eq(turnModelUsage.turnKey, turnKey))
        .all(),
    ).toEqual([
      expect.objectContaining({
        costUsd: 0.00042,
        model: "gpt-reconciled",
        requestCount: 2,
        totalTokens: 220,
        unpricedUsageCount: 0,
      }),
    ]);
  });
});

async function createHarness(
  options: {
    createInventory?: (sessionsDirectory: string) => SourceInventory;
    scanIntervalMs?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-test-"));
  temporaryDirectories.push(directory);
  const sessionsDirectory = join(directory, "sessions");
  await mkdir(sessionsDirectory, { recursive: true });
  const databasePath = join(directory, "usage.db");
  const database = createDatabase(databasePath);
  migrateDatabase(database);
  const inventory =
    options.createInventory?.(sessionsDirectory) ?? new SourceInventory(sessionsDirectory);
  const importer = new SessionImporter(database, sessionsDirectory, {
    inventory,
    ...(options.scanIntervalMs === undefined ? {} : { scanIntervalMs: options.scanIntervalMs }),
  });
  const retention = new RetentionService(
    database,
    databasePath,
    sessionsDirectory,
    () => new Date("2026-07-13T00:00:00.000Z"),
    inventory,
  );
  return {
    database,
    importer,
    inventory,
    retention,
    sessionsDirectory,
  } satisfies {
    database: AppDatabase;
    importer: SessionImporter;
    inventory: SourceInventory;
    retention: RetentionService;
    sessionsDirectory: string;
  };
}

async function createSessionFile(directory: string, lines: string[]): Promise<string> {
  const nestedDirectory = join(directory, "2026", "07", "12");
  await mkdir(nestedDirectory, { recursive: true });
  const filePath = join(nestedDirectory, `rollout-${Math.random().toString(16).slice(2)}.jsonl`);
  await writeFile(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

function sessionMeta(
  sessionId: string,
  options: {
    agentId?: string;
    cwd?: string;
    depth?: number;
    name?: string;
    parentThreadId?: string;
    role?: string;
    threadSource?: string;
  } = {},
): string {
  return JSON.stringify({
    payload: {
      ...(options.agentId ? { id: options.agentId } : {}),
      ...(options.depth === undefined
        ? {}
        : { source: { subagent: { thread_spawn: { depth: options.depth } } } }),
      ...(options.name ? { agent_nickname: options.name } : {}),
      ...(options.parentThreadId ? { parent_thread_id: options.parentThreadId } : {}),
      ...(options.role ? { agent_role: options.role } : {}),
      ...(options.threadSource ? { thread_source: options.threadSource } : {}),
      cwd: options.cwd ?? "/workspace",
      session_id: sessionId,
      timestamp: "2026-07-12T00:00:00.000Z",
    },
    timestamp: "2026-07-12T00:00:00.000Z",
    type: "session_meta",
  });
}

function userMessage(message: string): string {
  return JSON.stringify({
    payload: { message, type: "user_message" },
    timestamp: "2026-07-12T00:00:00.500Z",
    type: "event_msg",
  });
}

function turnContext(
  model: string,
  timestamp = "2026-07-12T00:00:01.000Z",
  turnId?: string,
): string {
  return JSON.stringify({
    payload: { model, ...(turnId ? { turn_id: turnId } : {}) },
    timestamp,
    type: "turn_context",
  });
}

function taskStarted(turnId: string, timestamp: string, timeToFirstTokenMs?: number): string {
  return JSON.stringify({
    payload: {
      started_at: timestamp,
      ...(timeToFirstTokenMs === undefined ? {} : { time_to_first_token_ms: timeToFirstTokenMs }),
      turn_id: turnId,
      type: "task_started",
    },
    timestamp,
    type: "event_msg",
  });
}

function taskCompleted(turnId: string, timestamp: string): string {
  return JSON.stringify({
    payload: { completed_at: timestamp, turn_id: turnId, type: "task_complete" },
    timestamp,
    type: "event_msg",
  });
}

function taskAborted(turnId: string, timestamp: string): string {
  return JSON.stringify({
    payload: { completed_at: timestamp, turn_id: turnId, type: "turn_aborted" },
    timestamp,
    type: "event_msg",
  });
}

function interAgentHandoff(timestamp: string): string {
  return JSON.stringify({
    payload: { trigger_turn: true },
    timestamp,
    type: "inter_agent_communication_metadata",
  });
}

function activityCall(callId: string, timestamp: string): string {
  return JSON.stringify({
    payload: { call_id: callId, name: "exec_command", type: "function_call" },
    timestamp,
    type: "response_item",
  });
}

function tokenCount(
  timestamp: string,
  input: number,
  cached: number,
  output: number,
  reasoning: number,
  cumulativeUsage?: { cached: number; input: number; output: number; reasoning: number },
  turnId?: string,
): string {
  return JSON.stringify({
    payload: {
      ...(turnId ? { turn_id: turnId } : {}),
      info: {
        ...(cumulativeUsage
          ? {
              total_token_usage: {
                cached_input_tokens: cumulativeUsage.cached,
                input_tokens: cumulativeUsage.input,
                output_tokens: cumulativeUsage.output,
                reasoning_output_tokens: cumulativeUsage.reasoning,
                total_tokens: cumulativeUsage.input + cumulativeUsage.output,
              },
            }
          : {}),
        last_token_usage: {
          cached_input_tokens: cached,
          input_tokens: input,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: input + output,
        },
      },
      type: "token_count",
    },
    timestamp,
    type: "event_msg",
  });
}
