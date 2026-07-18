import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDailyMinuteReport } from "@/server/analytics";
import { createApp } from "@/server/app";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import {
  projects,
  sessionAgents,
  sessions,
  usageDailyRollups,
  usageEvents,
  usageHourlyRollups,
} from "@/server/db/schema";
import { SessionImporter } from "@/server/importer";
import { RetentionService } from "@/server/retention";

type Harness = Awaited<ReturnType<typeof createHarness>>;

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  seedMinuteUsage(harness.database);
});

afterEach(async () => {
  harness.database.$client.close();
  await rm(harness.directory, { force: true, recursive: true });
});

describe("daily minute report", () => {
  it("aggregates raw usage into exact five-minute buckets and zero-fills elapsed time", () => {
    const report = getDailyMinuteReport(
      harness.database,
      { from: "2026-07-18", to: "2026-07-18" },
      fixedNow(),
    );

    expect(report).toMatchObject({
      available: true,
      availableDate: "2026-07-18",
      bucketMinutes: 5,
      date: "2026-07-18",
      generatedAt: fixedNow().toISOString(),
      timeZone: "Asia/Ho_Chi_Minh",
    });
    expect(report.buckets).toHaveLength(3);
    expect(report.buckets.map((bucket) => bucket.minute)).toEqual(["00:00", "00:05", "00:10"]);
    expect(report.buckets[0]).toEqual({
      cachedInputTokens: 140,
      estimatedCostUsd: 1,
      inputTokens: 300,
      minute: "00:00",
      outputTokens: 30,
      reasoningOutputTokens: 15,
      requestCount: 2,
      sessionCount: 1,
      totalTokens: 330,
      unpricedUsageCount: 1,
    });
    expect(report.buckets[1]).toMatchObject({
      estimatedCostUsd: 2.5,
      inputTokens: 350,
      minute: "00:05",
      requestCount: 2,
      sessionCount: 2,
      totalTokens: 385,
      unpricedUsageCount: 0,
    });
    expect(report.buckets[2]).toEqual({
      cachedInputTokens: 0,
      estimatedCostUsd: 0,
      inputTokens: 0,
      minute: "00:10",
      outputTokens: 0,
      reasoningOutputTokens: 0,
      requestCount: 0,
      sessionCount: 0,
      totalTokens: 0,
      unpricedUsageCount: 0,
    });
    expect(report.modelCalls).toEqual([
      { minute: "00:00", model: "model-a", requestCount: 2 },
      { minute: "00:05", model: "model-a", requestCount: 1 },
      { minute: "00:05", model: "model-b", requestCount: 1 },
    ]);
    expect(report.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0)).toBe(715);
  });

  it("applies dashboard filters without reading hourly or daily rollups", () => {
    const alpha = getDailyMinuteReport(
      harness.database,
      {
        agentKind: "main",
        from: "2026-07-18",
        models: ["model-a"],
        projectId: "project-alpha",
        to: "2026-07-18",
      },
      fixedNow(),
    );
    const beta = getDailyMinuteReport(
      harness.database,
      {
        agentKind: "subagent",
        from: "2026-07-18",
        model: "model-b",
        projectId: "project-beta",
        to: "2026-07-18",
      },
      fixedNow(),
    );

    expect(alpha.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0)).toBe(385);
    expect(alpha.buckets.reduce((sum, bucket) => sum + bucket.requestCount, 0)).toBe(3);
    expect(alpha.modelCalls).toEqual([
      { minute: "00:00", model: "model-a", requestCount: 2 },
      { minute: "00:05", model: "model-a", requestCount: 1 },
    ]);
    expect(beta.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0)).toBe(330);
    expect(beta.buckets.reduce((sum, bucket) => sum + bucket.requestCount, 0)).toBe(1);
    expect(beta.modelCalls).toEqual([{ minute: "00:05", model: "model-b", requestCount: 1 }]);
  });

  it("exposes only the current local date and caps a complete day at 288 buckets", () => {
    const unavailable = getDailyMinuteReport(
      harness.database,
      { from: "2026-07-17", to: "2026-07-17" },
      fixedNow(),
    );
    const endOfDay = getDailyMinuteReport(
      harness.database,
      { from: "2026-07-18", to: "2026-07-18" },
      new Date("2026-07-18T16:59:59.000Z"),
    );

    expect(unavailable).toMatchObject({
      available: false,
      availableDate: "2026-07-18",
      buckets: [],
      date: "2026-07-17",
      modelCalls: [],
    });
    expect(endOfDay.buckets).toHaveLength(288);
    expect(endOfDay.buckets.at(-1)?.minute).toBe("23:55");
  });

  it("validates the Hono query and preserves unavailable dates as a successful response", async () => {
    const app = createApp(harness.database, harness.importer, harness.retention);

    expect((await app.request("/api/dashboard/minutes")).status).toBe(400);
    expect((await app.request("/api/dashboard/minutes?date=2026-02-30")).status).toBe(400);

    const response = await app.request("/api/dashboard/minutes?date=2000-01-01");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: false,
      buckets: [],
      date: "2000-01-01",
    });
  });
});

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-minute-report-test-"));
  const sessionsDirectory = join(directory, "sessions");
  await mkdir(sessionsDirectory, { recursive: true });
  const databasePath = join(directory, "usage.db");
  const database = createDatabase(databasePath);
  migrateDatabase(database);
  return {
    database,
    databasePath,
    directory,
    importer: new SessionImporter(database, sessionsDirectory),
    retention: new RetentionService(database, databasePath, sessionsDirectory, fixedNow),
    sessionsDirectory,
  };
}

function seedMinuteUsage(database: AppDatabase) {
  const createdAt = fixedNow().getTime();
  database
    .insert(projects)
    .values([
      {
        createdAt,
        displayName: "Alpha",
        displayPath: "/workspace/alpha",
        id: "project-alpha",
        normalizedPath: "/workspace/alpha",
        updatedAt: createdAt,
      },
      {
        createdAt,
        displayName: "Beta",
        displayPath: "/workspace/beta",
        id: "project-beta",
        normalizedPath: "/workspace/beta",
        updatedAt: createdAt,
      },
    ])
    .run();
  database
    .insert(sessions)
    .values([
      {
        id: "session-alpha",
        lastSeenAt: createdAt,
        projectId: "project-alpha",
        sourcePath: "/sources/alpha.jsonl",
      },
      {
        id: "session-beta",
        lastSeenAt: createdAt,
        projectId: "project-beta",
        sourcePath: "/sources/beta.jsonl",
      },
    ])
    .run();
  database
    .insert(sessionAgents)
    .values([
      {
        id: "agent-main",
        lastSeenAt: createdAt,
        sessionId: "session-alpha",
        sourcePath: "/sources/alpha.jsonl",
        threadSource: "user",
      },
      {
        depth: 1,
        id: "agent-sub",
        lastSeenAt: createdAt,
        sessionId: "session-beta",
        sourcePath: "/sources/beta.jsonl",
        threadSource: "subagent",
      },
    ])
    .run();
  database
    .insert(usageEvents)
    .values([
      usageEvent({
        agentId: "agent-main",
        cachedInputTokens: 40,
        costUsd: 1,
        id: "usage-0000",
        inputTokens: 100,
        model: "model-a",
        outputTokens: 10,
        sessionId: "session-alpha",
        timestamp: "2026-07-17T17:00:00.000Z",
      }),
      usageEvent({
        agentId: "agent-main",
        cachedInputTokens: 100,
        costUsd: null,
        id: "usage-0004",
        inputTokens: 200,
        model: "model-a",
        outputTokens: 20,
        sessionId: "session-alpha",
        timestamp: "2026-07-17T17:04:59.000Z",
      }),
      usageEvent({
        agentId: "agent-sub",
        cachedInputTokens: 150,
        costUsd: 2,
        id: "usage-0005-sub",
        inputTokens: 300,
        model: "model-b",
        outputTokens: 30,
        sessionId: "session-beta",
        timestamp: "2026-07-17T17:05:00.000Z",
      }),
      usageEvent({
        agentId: "agent-main",
        cachedInputTokens: 20,
        costUsd: 0.5,
        id: "usage-0007-main",
        inputTokens: 50,
        model: "model-a",
        outputTokens: 5,
        sessionId: "session-alpha",
        timestamp: "2026-07-17T17:07:00.000Z",
      }),
    ])
    .run();
  database
    .insert(usageHourlyRollups)
    .values({ ...rollup({ model: "archived-hourly" }), localHour: "00:00" })
    .run();
  database
    .insert(usageDailyRollups)
    .values(rollup({ model: "archived-daily" }))
    .run();
}

function usageEvent(value: {
  agentId: string;
  cachedInputTokens: number;
  costUsd: number | null;
  id: string;
  inputTokens: number;
  model: string;
  outputTokens: number;
  sessionId: string;
  timestamp: string;
}): typeof usageEvents.$inferInsert {
  return {
    ...value,
    cachedInputRate: value.costUsd === null ? null : 0.5,
    createdAt: Date.parse(value.timestamp),
    inputRate: value.costUsd === null ? null : 2,
    localDate: "2026-07-18",
    outputRate: value.costUsd === null ? null : 4,
    reasoningOutputTokens: Math.floor(value.outputTokens / 2),
    sourceHash: `hash-${value.id}`,
    totalTokens: value.inputTokens + value.outputTokens,
  };
}

function rollup(value: { model: string }) {
  return {
    agentKind: "main",
    cachedInputTokens: 9_000,
    costUsd: 9_000,
    inputTokens: 9_000,
    localDate: "2026-07-18",
    model: value.model,
    outputTokens: 9_000,
    projectId: "project-alpha",
    reasoningOutputTokens: 9_000,
    requestCount: 9_000,
    totalTokens: 9_000,
    unpricedCachedInputTokens: 0,
    unpricedInputTokens: 0,
    unpricedOutputTokens: 0,
    unpricedUsageCount: 0,
  };
}

function fixedNow() {
  return new Date("2026-07-17T17:12:30.000Z");
}
