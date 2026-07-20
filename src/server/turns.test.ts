import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/server/app";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import {
  activityEvents,
  projects,
  sessionAgents,
  sessions,
  turnActivityRollups,
  turnModelUsage,
  turns,
  usageEvents,
} from "@/server/db/schema";
import { SessionImporter } from "@/server/importer";
import { RetentionService } from "@/server/retention";
import { createTag, replaceProjectTags } from "@/server/tags";
import {
  compareTurns,
  getTurnDetail,
  getTurnDiagnostics,
  getTurns,
  TurnDiagnosticsLimitError,
} from "@/server/turns";
import type { TurnBackfillStatus } from "@/shared/types";

const backfill: TurnBackfillStatus = {
  attributionVersion: 1,
  costAttributionMissingCount: 0,
  error: null,
  filesProcessed: 2,
  isRunning: false,
  lastRunAt: "2026-07-14T00:00:00.000Z",
  sourceDeletedGaps: 0,
  totalFiles: 2,
};

type Harness = Awaited<ReturnType<typeof createHarness>>;
let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  seedTurns(harness.database);
});

afterEach(async () => {
  harness.database.$client.close();
  await rm(harness.directory, { force: true, recursive: true });
});

describe("turn analytics", () => {
  it("returns KPI, trend, context buckets and model-scoped totals", () => {
    const response = getTurns(
      harness.database,
      { from: "2026-07-12", to: "2026-07-13" },
      backfill,
      false,
    );

    expect(response.total).toBe(3);
    expect(response.kpis).toMatchObject({
      averageCostPerTurn: null,
      contextPressureTurnCount: 2,
      costCoverage: "partial",
      estimatedCostUsd: 3,
      p50DurationMs: 1_000,
      p50TimeToFirstTokenMs: 100,
      p95DurationMs: 2_000,
      totalTokens: 385,
      turnCount: 3,
    });
    expect(response.kpis.cacheRate).toBeCloseTo((205 / 350) * 100);
    expect(response.daily).toEqual([
      {
        costCoverage: "exact",
        date: "2026-07-12",
        estimatedCostUsd: 3,
        totalTokens: 330,
        turnCount: 1,
      },
      {
        costCoverage: "unavailable",
        date: "2026-07-13",
        estimatedCostUsd: 0,
        totalTokens: 55,
        turnCount: 2,
      },
    ]);
    expect(response.contextBuckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ count: 1, id: "70-84" }),
        expect.objectContaining({ count: 1, id: "95+" }),
        expect.objectContaining({ count: 1, id: "unknown" }),
      ]),
    );
    expect(response.liveRefreshSuggested).toBe(false);
    expect(
      getTurns(harness.database, { from: "2026-07-12", to: "2026-07-13" }, backfill, true)
        .liveRefreshSuggested,
    ).toBe(true);
    expect(
      getTurnDiagnostics(harness.database, { from: "2026-07-12", to: "2026-07-13" }, backfill)
        .baselines,
    ).toMatchObject({
      cost: { baselineAvailable: false, eligibleCount: 2, unavailableCount: 1 },
      duration: { baselineAvailable: false, eligibleCount: 2, unavailableCount: 1 },
      ttft: { baselineAvailable: false, eligibleCount: 2, unavailableCount: 1 },
    });

    const modelA = getTurns(
      harness.database,
      { from: "2026-07-12", models: ["model-a"], to: "2026-07-13" },
      backfill,
      false,
    );
    expect(modelA.total).toBe(1);
    expect(modelA.kpis).toMatchObject({
      costCoverage: "exact",
      estimatedCostUsd: 1,
      totalTokens: 110,
      turnCount: 1,
    });
    expect(modelA.turns[0]).toMatchObject({
      costCoverage: "exact",
      estimatedCostUsd: 1,
      models: ["model-a"],
      totalTokens: 110,
    });
    expect(
      getTurnDiagnostics(
        harness.database,
        { from: "2026-07-12", models: ["model-a"], projectId: "project-a", to: "2026-07-13" },
        backfill,
      ).matchedTurnCount,
    ).toBe(1);
  });

  it("filters, sorts and paginates without weakening cost coverage", () => {
    const pressure = getTurns(
      harness.database,
      {
        from: "2026-07-12",
        order: "desc",
        pressure: "95",
        query: "Mapper",
        sort: "context",
        status: "aborted",
        to: "2026-07-13",
      },
      backfill,
      false,
    );
    expect(pressure.turns).toHaveLength(1);
    expect(pressure.turns[0]).toMatchObject({
      agentKind: "subagent",
      agentName: "Mapper",
      contextUtilizationPercent: 96,
      costCoverage: "unavailable",
      status: "aborted",
    });
    expect(
      getTurns(
        harness.database,
        { from: "2026-07-12", pressure: "70-84", to: "2026-07-13" },
        backfill,
        false,
      ).turns.map((turn) => turn.turnKey),
    ).toEqual([turnKeys.first]);
    expect(
      getTurns(
        harness.database,
        { from: "2026-07-12", pressure: "95+", to: "2026-07-13" },
        backfill,
        false,
      ).turns.map((turn) => turn.turnKey),
    ).toEqual([turnKeys.second]);
    expect(
      getTurns(
        harness.database,
        { from: "2026-07-12", pressure: "unknown", to: "2026-07-13" },
        backfill,
        false,
      ).turns.map((turn) => turn.turnKey),
    ).toEqual([turnKeys.third]);
    expect(
      getTurns(
        harness.database,
        { from: "2026-07-12", pressure: "85-94", to: "2026-07-13" },
        backfill,
        false,
      ).turns,
    ).toEqual([]);

    for (const sort of ["cost", "duration", "lastActivity", "tokens", "ttft"] as const) {
      const page = getTurns(
        harness.database,
        {
          from: "2026-07-12",
          order: "asc",
          page: 2,
          pageSize: 1,
          sort,
          to: "2026-07-13",
        },
        backfill,
        false,
      );
      expect(page.page).toBe(2);
      expect(page.pageSize).toBe(1);
      expect(page.turns).toHaveLength(1);
    }
  });

  it("filters retained turn aggregates by project tags", () => {
    harness.database
      .insert(projects)
      .values({
        createdAt: 1,
        displayName: "Project A",
        displayPath: "/project-a",
        id: "project-a",
        normalizedPath: "/project-a",
        updatedAt: 1,
      })
      .run();
    const selected = createTag(harness.database, "Selected");
    const other = createTag(harness.database, "Other");
    expect(replaceProjectTags(harness.database, "project-a", [selected.id])).toMatchObject({
      status: "ok",
    });

    expect(
      getTurns(
        harness.database,
        { from: "2026-07-12", tagIds: [selected.id], to: "2026-07-13" },
        backfill,
        false,
      ).total,
    ).toBe(3);
    expect(
      getTurns(
        harness.database,
        { from: "2026-07-12", tagIds: [other.id], to: "2026-07-13" },
        backfill,
        false,
      ).total,
    ).toBe(0);
    expect(
      getTurnDiagnostics(
        harness.database,
        { from: "2026-07-12", tagIds: [selected.id], to: "2026-07-13" },
        backfill,
      ).matchedTurnCount,
    ).toBe(3);
  });

  it("computes full-range baselines and deterministic top 50 from retained aggregates", () => {
    seedDiagnosticTurns(harness.database, 60);
    const response = getTurnDiagnostics(
      harness.database,
      { from: "2026-07-14", to: "2026-07-14" },
      backfill,
    );
    expect(response.matchedTurnCount).toBe(60);
    expect(response.baselines.duration).toEqual({
      baselineAvailable: true,
      eligibleCount: 59,
      median: 31,
      p95: 58,
      unavailableCount: 1,
    });
    expect(response.baselines.ttft).toMatchObject({
      baselineAvailable: true,
      eligibleCount: 59,
      unavailableCount: 1,
    });
    expect(response.baselines.cost).toMatchObject({
      baselineAvailable: true,
      eligibleCount: 58,
      unavailableCount: 2,
    });
    expect(response.items).toHaveLength(50);
    expect(response.items[0]).toMatchObject({
      reasons: expect.arrayContaining(["context-95"]),
      turn: { turnId: "diagnostic-10" },
    });
    expect(response.outlierTurnCount).toBe(60);
    expect(response.coverage).toMatchObject({ aggregate: "full", timeline: { status: "full" } });

    harness.database.delete(usageEvents).run();
    harness.database.delete(activityEvents).run();
    expect(
      getTurnDiagnostics(harness.database, { from: "2026-07-14", to: "2026-07-14" }, backfill)
        .matchedTurnCount,
    ).toBe(60);
  });

  it("keeps aggregate diagnostics when raw timelines have expired and reports source gaps", () => {
    harness.database
      .insert(turns)
      .values({
        agentId: "session-main",
        createdAt: 1,
        id: "f".repeat(64),
        lastEventAt: "2026-04-01T00:00:00.000Z",
        localDate: "2026-04-01",
        projectId: "project-a",
        sessionId: "session-main",
        status: "completed",
        turnId: "retained-only",
        updatedAt: 1,
      })
      .run();
    const response = getTurnDiagnostics(
      harness.database,
      { from: "2026-04-01", to: "2026-04-01" },
      { ...backfill, sourceDeletedGaps: 1 },
    );
    expect(response).toMatchObject({
      coverage: { aggregate: "partial", timeline: { status: "none" } },
      matchedTurnCount: 1,
    });
  });

  it("rejects diagnostics ranges over 90 days and matches over 20,000 turns", async () => {
    expect(() =>
      getTurnDiagnostics(harness.database, { from: "2026-01-01", to: "2026-04-01" }, backfill),
    ).toThrow(TurnDiagnosticsLimitError);

    harness.database.$client.exec(`
      with recursive sequence(value) as (
        select 1
        union all
        select value + 1 from sequence where value < 20001
      )
      insert into turns (
        id, turn_id, session_id, agent_id, project_id, local_date,
        last_event_at, status, created_at, updated_at
      )
      select
        printf('%064x', 100000 + value),
        'bulk-' || value,
        'session-main',
        'session-main',
        'project-a',
        '2026-08-01',
        '2026-08-01T00:00:00.000Z',
        'completed',
        1,
        1
      from sequence;
    `);
    expect(() =>
      getTurnDiagnostics(harness.database, { from: "2026-08-01", to: "2026-08-01" }, backfill),
    ).toThrow("matched more than 20,000 turns");

    const app = createApp(harness.database, harness.importer, harness.retention);
    expect((await app.request("/api/turns/diagnostics?from=2026-01-01&to=2026-04-01")).status).toBe(
      422,
    );
    expect((await app.request("/api/turns/diagnostics?from=2026-08-01&to=2026-08-01")).status).toBe(
      422,
    );
    expect(
      (await app.request("/api/turns/diagnostics?from=2026-07-12&to=2026-07-13&page=1")).status,
    ).toBe(400);
  });

  it("returns detail timelines and compare results in requested order", () => {
    const detail = getTurnDetail(harness.database, turnKeys.first);
    expect(detail?.turn).toMatchObject({ ordinal: 1, totalTokens: 330 });
    expect(detail?.models.map((model) => model.model)).toEqual(["model-a", "model-b"]);
    expect(detail?.requests).toHaveLength(3);
    expect(detail?.activity).toEqual([{ count: 1, kind: "shell" }]);
    expect(detail?.activityTimeline).toHaveLength(1);
    expect(detail?.threadAgents).toHaveLength(2);
    expect(detail?.timelineCoverage).toEqual({
      from: "2026-07-12",
      status: "full",
      to: "2026-07-12",
    });
    expect(detail?.timelineTruncated).toBe(false);

    harness.database.delete(activityEvents).where(eq(activityEvents.id, "activity-1")).run();
    expect(getTurnDetail(harness.database, turnKeys.first)?.timelineCoverage.status).toBe(
      "partial",
    );

    const missing = "f".repeat(64);
    const compared = compareTurns(harness.database, [turnKeys.second, turnKeys.first, missing]);
    expect(compared.turns.map((turn) => turn.turnKey)).toEqual([turnKeys.second, turnKeys.first]);
    expect(compared.missingIds).toEqual([missing]);
    expect(getTurnDetail(harness.database, missing)).toBeNull();
  });

  it("exposes additive API routes with bounded validation", async () => {
    const app = createApp(harness.database, harness.importer, harness.retention);
    const response = await app.request("/api/turns?from=2026-07-12&to=2026-07-13&models=model-a");
    expect(response.status).toBe(200);
    expect((await response.json()) as { total: number }).toMatchObject({ total: 1 });

    const detail = await app.request(`/api/turns/${turnKeys.first}`);
    expect(detail.status).toBe(200);
    const compare = await app.request(
      `/api/turns/compare?ids=${turnKeys.second},${turnKeys.first}`,
    );
    expect(compare.status).toBe(200);
    expect(
      ((await compare.json()) as { turns: { turnKey: string }[] }).turns.map(
        (turn) => turn.turnKey,
      ),
    ).toEqual([turnKeys.second, turnKeys.first]);

    const exported = await app.request(
      "/api/export?dataset=turns&format=json&from=2026-07-12&to=2026-07-13",
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain(
      'filename="codex-usage-turns.json"',
    );
    expect((await exported.json()) as unknown[]).toHaveLength(3);

    expect((await app.request("/api/turns?from=bad&to=2026-07-13")).status).toBe(400);
    expect((await app.request("/api/turns?pageSize=101")).status).toBe(400);
    expect((await app.request("/api/turns?pressure=unknown")).status).toBe(200);
    expect((await app.request("/api/turns?pressure=80")).status).toBe(400);
    expect((await app.request(`/api/turns/compare?ids=${turnKeys.first}`)).status).toBe(400);
    expect((await app.request("/api/turns/not-a-key")).status).toBe(400);
  });
});

const turnKeys = {
  first: "1".repeat(64),
  second: "2".repeat(64),
  third: "3".repeat(64),
};

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-turns-test-"));
  const sessionsDirectory = join(directory, "sessions");
  await mkdir(sessionsDirectory, { recursive: true });
  const databasePath = join(directory, "usage.db");
  const database = createDatabase(databasePath);
  migrateDatabase(database);
  return {
    database,
    directory,
    importer: new SessionImporter(database, sessionsDirectory),
    retention: new RetentionService(
      database,
      databasePath,
      sessionsDirectory,
      () => new Date("2026-07-15T00:00:00.000Z"),
    ),
  };
}

function seedTurns(database: AppDatabase) {
  database
    .insert(sessions)
    .values({
      id: "session-main",
      lastSeenAt: 1,
      projectId: "project-a",
      sourceDeleted: false,
      sourcePath: "/fixture/main.jsonl",
      startedAt: "2026-07-12T01:00:00.000Z",
      title: "Phân tích usage",
    })
    .run();
  database
    .insert(sessionAgents)
    .values([
      {
        depth: 0,
        id: "session-main",
        lastSeenAt: 1,
        sessionId: "session-main",
        sourceDeleted: false,
        sourcePath: "/fixture/main.jsonl",
        threadSource: "main",
      },
      {
        depth: 1,
        id: "agent-mapper",
        lastSeenAt: 1,
        name: "Mapper",
        parentThreadId: "session-main",
        role: "explorer",
        sessionId: "session-main",
        sourceDeleted: false,
        sourcePath: "/fixture/subagent.jsonl",
        threadSource: "subagent",
      },
    ])
    .run();
  database
    .insert(turns)
    .values([
      {
        agentId: "session-main",
        completedAt: "2026-07-12T01:00:01.000Z",
        createdAt: 1,
        durationMs: 1_000,
        id: turnKeys.first,
        lastEventAt: "2026-07-12T01:00:01.000Z",
        localDate: "2026-07-12",
        modelContextWindow: 1_000,
        peakInputTokens: 800,
        projectId: "project-a",
        sessionId: "session-main",
        startedAt: "2026-07-12T01:00:00.000Z",
        status: "completed",
        timeToFirstTokenMs: 100,
        turnId: "turn-one",
        updatedAt: 1,
      },
      {
        agentId: "agent-mapper",
        completedAt: "2026-07-13T02:00:02.000Z",
        createdAt: 1,
        durationMs: 2_000,
        id: turnKeys.second,
        lastEventAt: "2026-07-13T02:00:02.000Z",
        localDate: "2026-07-13",
        modelContextWindow: 1_000,
        peakInputTokens: 960,
        projectId: "project-a",
        sessionId: "session-main",
        startedAt: "2026-07-13T02:00:00.000Z",
        status: "aborted",
        timeToFirstTokenMs: 200,
        turnId: "turn-two",
        updatedAt: 1,
      },
      {
        agentId: "session-main",
        createdAt: 1,
        id: turnKeys.third,
        lastEventAt: "2026-07-13T03:00:00.000Z",
        localDate: "2026-07-13",
        projectId: "project-a",
        sessionId: "session-main",
        startedAt: "2026-07-13T03:00:00.000Z",
        status: "unknown",
        turnId: "turn-three",
        updatedAt: 1,
      },
    ])
    .run();
  database
    .insert(turnModelUsage)
    .values([
      usageRollup(turnKeys.first, "model-a", 100, 80, 10, 110, 2, 1, 0),
      usageRollup(turnKeys.first, "model-b", 200, 100, 20, 220, 1, 2, 0),
      usageRollup(turnKeys.second, "model-b", 50, 25, 5, 55, 1, 0, 1),
    ])
    .run();
  database
    .insert(usageEvents)
    .values([
      rawUsage(
        "request-1",
        turnKeys.first,
        "model-a",
        "2026-07-12T01:00:00.100Z",
        50,
        40,
        5,
        55,
        0.5,
      ),
      rawUsage(
        "request-2",
        turnKeys.first,
        "model-a",
        "2026-07-12T01:00:00.200Z",
        50,
        40,
        5,
        55,
        0.5,
      ),
      rawUsage(
        "request-3",
        turnKeys.first,
        "model-b",
        "2026-07-12T01:00:00.300Z",
        200,
        100,
        20,
        220,
        2,
      ),
      rawUsage(
        "request-4",
        turnKeys.second,
        "model-b",
        "2026-07-13T02:00:00.200Z",
        50,
        25,
        5,
        55,
        null,
        "agent-mapper",
      ),
    ])
    .run();
  database
    .insert(turnActivityRollups)
    .values({ eventCount: 1, kind: "shell", turnKey: turnKeys.first })
    .run();
  database
    .insert(activityEvents)
    .values({
      agentId: "session-main",
      agentKind: "main",
      createdAt: 1,
      id: "activity-1",
      kind: "shell",
      localDate: "2026-07-12",
      projectId: "project-a",
      sessionId: "session-main",
      timestamp: "2026-07-12T01:00:00.250Z",
      turnAttributionVersion: 1,
      turnKey: turnKeys.first,
    })
    .run();
}

function seedDiagnosticTurns(database: AppDatabase, count: number) {
  const values = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    return {
      agentId: "session-main",
      completedAt: `2026-07-14T00:00:${String(offset).padStart(2, "0")}.000Z`,
      createdAt: 1,
      durationMs: index === 1 ? null : index,
      id: (1_000 + index).toString(16).padStart(64, "0"),
      lastEventAt: `2026-07-14T00:00:${String(offset).padStart(2, "0")}.000Z`,
      localDate: "2026-07-14",
      modelContextWindow: 100,
      peakInputTokens: index <= 10 ? 95 : index <= 20 ? 85 : 70,
      projectId: "project-a",
      sessionId: "session-main",
      startedAt: "2026-07-14T00:00:00.000Z",
      status: "completed",
      timeToFirstTokenMs: index === 2 ? null : index * 2,
      turnId: `diagnostic-${index}`,
      updatedAt: 1,
    } satisfies typeof turns.$inferInsert;
  });
  database.insert(turns).values(values).run();
  database
    .insert(turnModelUsage)
    .values(
      values.map((turn, offset) => {
        const index = offset + 1;
        return usageRollup(
          turn.id,
          "diagnostic-model",
          index,
          0,
          1,
          index + 1,
          index === 1 ? 2 : 1,
          index,
          index <= 2 ? 1 : 0,
        );
      }),
    )
    .run();
}

function usageRollup(
  turnKey: string,
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  totalTokens: number,
  requestCount: number,
  costUsd: number,
  unpricedUsageCount: number,
) {
  return {
    cachedInputTokens,
    costAttributionMissingCount: 0,
    costUsd,
    inputTokens,
    model,
    outputTokens,
    reasoningOutputTokens: outputTokens,
    requestCount,
    totalTokens,
    turnKey,
    unpricedCachedInputTokens: unpricedUsageCount > 0 ? cachedInputTokens : 0,
    unpricedInputTokens: unpricedUsageCount > 0 ? inputTokens : 0,
    unpricedOutputTokens: unpricedUsageCount > 0 ? outputTokens : 0,
    unpricedUsageCount,
  };
}

function rawUsage(
  id: string,
  turnKey: string,
  model: string,
  timestamp: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  totalTokens: number,
  costUsd: number | null,
  agentId = "session-main",
) {
  return {
    agentId,
    cachedInputRate: costUsd === null ? null : 0.5,
    cachedInputTokens,
    costUsd,
    createdAt: 1,
    id,
    inputRate: costUsd === null ? null : 1,
    inputTokens,
    localDate: timestamp.slice(0, 10),
    model,
    outputRate: costUsd === null ? null : 2,
    outputTokens,
    reasoningOutputTokens: outputTokens,
    sessionId: "session-main",
    sourceHash: `hash-${id}`,
    timestamp,
    totalTokens,
    turnAttributionVersion: 1,
    turnKey,
  };
}
