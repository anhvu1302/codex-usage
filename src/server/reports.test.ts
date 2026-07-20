import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/server/app";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import {
  projects,
  sessionAgents,
  sessions,
  turnModelUsage,
  turns,
  usageEvents,
} from "@/server/db/schema";
import { SessionImporter } from "@/server/importer";
import { exportReport, previewReport, ReportRequestError } from "@/server/reports";
import { RetentionService } from "@/server/retention";
import type { ReportPreset, ReportRequest, TurnBackfillStatus } from "@/shared/types";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const backfill: TurnBackfillStatus = {
  attributionVersion: 1,
  costAttributionMissingCount: 0,
  error: null,
  filesProcessed: 1,
  isRunning: false,
  lastRunAt: "2026-07-12T00:00:00.000Z",
  sourceDeletedGaps: 0,
  totalFiles: 1,
};

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  seedReportData(harness.database);
});

afterEach(async () => {
  harness.database.$client.close();
  await rm(harness.directory, { force: true, recursive: true });
});

describe("report projection pipeline", () => {
  it("previews all presets with server-owned defaults and exact row counts", () => {
    for (const preset of [
      "cost-overview",
      "project-summary",
      "agent-summary",
      "session-summary",
      "turn-summary",
    ] as const) {
      const preview = previewReport(harness.database, request(preset), backfill);
      expect(preview.availableColumns.length).toBeGreaterThan(0);
      expect(preview.resolvedColumns.length).toBeGreaterThan(0);
      expect(preview.resolvedColumns.every((column) => column.selectedByDefault)).toBe(true);
      expect(preview.rowCount).toMatchObject({ kind: "exact", value: expect.any(Number) });
      expect(preview.rows.length).toBeLessThanOrEqual(20);
      expect(preview.coverage.aggregate).toBe("full");
    }
  });

  it("uses one ordered projection for preview, JSON and injection-safe CSV", () => {
    const value: ReportRequest = {
      acknowledgeSensitive: [],
      columns: ["projectDisplayName", "estimatedCostUsd"],
      filters: { from: "2026-07-12", to: "2026-07-12" },
      format: "json",
      preset: "project-summary",
    };
    const preview = previewReport(harness.database, value, backfill);
    expect(preview.resolvedColumns.map((column) => column.id)).toEqual([
      "projectDisplayName",
      "estimatedCostUsd",
    ]);
    expect(preview.sensitiveWarning).toContain("Tên project");
    expect(preview.acknowledgementMatches).toBe(false);
    expect(() => exportReport(harness.database, value, backfill)).toThrow(ReportRequestError);

    const acknowledged: ReportRequest = {
      ...value,
      acknowledgeSensitive: ["projectDisplayName"],
    };
    const exported = exportReport(harness.database, acknowledged, backfill);
    expect(JSON.parse(exported.body)).toEqual(preview.rows);
    expect(Object.keys((JSON.parse(exported.body) as Record<string, unknown>[])[0] ?? {})).toEqual([
      "projectDisplayName",
      "estimatedCostUsd",
    ]);

    const csv = exportReport(harness.database, { ...acknowledged, format: "csv" }, backfill).body;
    expect(csv.split("\n")[0]).toBe('"projectDisplayName","estimatedCostUsd"');
    expect(csv).toContain('"\'=SUM(A1:A2)"');
  });

  it("caps preview at 20 rows and rejects range, column, acknowledgement and row bounds", async () => {
    seedDailyRows(harness.database, 25);
    const daily = previewReport(
      harness.database,
      {
        acknowledgeSensitive: [],
        columns: [],
        filters: { from: "2026-06-18", to: "2026-07-12" },
        format: "json",
        preset: "cost-overview",
      },
      backfill,
    );
    expect(daily.rowCount).toEqual({ kind: "exact", value: 25 });
    expect(daily.rows).toHaveLength(20);

    expect(() =>
      previewReport(
        harness.database,
        {
          acknowledgeSensitive: [],
          columns: [],
          filters: { from: "2025-01-01", to: "2026-01-02" },
          format: "json",
          preset: "cost-overview",
        },
        backfill,
      ),
    ).toThrow("at most 366 days");
    expect(() =>
      previewReport(
        harness.database,
        {
          acknowledgeSensitive: [],
          columns: ["date", "date"],
          filters: { from: "2026-07-12", to: "2026-07-12" },
          format: "json",
          preset: "cost-overview",
        },
        backfill,
      ),
    ).toThrow("must be unique");

    const app = createApp(harness.database, harness.importer, harness.retention);
    const invalidColumn = await app.request("/api/reports/preview", {
      body: JSON.stringify({
        acknowledgeSensitive: [],
        columns: ["sourcePath"],
        filters: { from: "2026-07-12", to: "2026-07-12" },
        format: "json",
        preset: "session-summary",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(invalidColumn.status).toBe(400);

    const tooManyColumns = await app.request("/api/reports/preview", {
      body: JSON.stringify({
        acknowledgeSensitive: [],
        columns: Array.from({ length: 31 }, () => "date"),
        filters: { from: "2026-07-12", to: "2026-07-12" },
        format: "json",
        preset: "cost-overview",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(tooManyColumns.status).toBe(422);
    expect(await tooManyColumns.json()).toEqual({
      error: "Reports support at most 30 columns",
    });

    const tooLongRange = await app.request("/api/reports/preview", {
      body: JSON.stringify({
        acknowledgeSensitive: [],
        columns: [],
        filters: { from: "2025-01-01", to: "2026-01-02" },
        format: "json",
        preset: "cost-overview",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(tooLongRange.status).toBe(422);

    harness.database.$client.exec(`
      with recursive sequence(value) as (
        select 1
        union all
        select value + 1 from sequence where value < 100001
      )
      insert into turns (
        id, turn_id, session_id, agent_id, project_id, local_date,
        last_event_at, status, created_at, updated_at
      )
      select
        printf('%064x', 200000 + value),
        'report-bulk-' || value,
        'session-report',
        'session-report',
        'project-report',
        '2026-07-13',
        '2026-07-13T00:00:00.000Z',
        'completed',
        1,
        1
      from sequence;
    `);
    expect(() =>
      previewReport(
        harness.database,
        {
          acknowledgeSensitive: [],
          columns: [],
          filters: { from: "2026-07-13", to: "2026-07-13" },
          format: "json",
          preset: "turn-summary",
        },
        backfill,
      ),
    ).toThrow("exceeds 100,000 rows");
  });

  it("serves preview/export with privacy acknowledgement and keeps legacy export", async () => {
    const app = createApp(harness.database, harness.importer, harness.retention);
    const payload = {
      acknowledgeSensitive: [],
      columns: ["sessionTitle", "totalTokens"],
      filters: { from: "2026-07-12", to: "2026-07-12" },
      format: "json",
      preset: "session-summary",
    };
    const preview = await app.request("/api/reports/preview", {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      acknowledgementMatches: false,
      rows: [{ sessionTitle: "=PRIVATE()", totalTokens: 110 }],
    });
    expect(
      (
        await app.request("/api/reports/export", {
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
    ).toBe(422);

    const exported = await app.request("/api/reports/export", {
      body: JSON.stringify({ ...payload, acknowledgeSensitive: ["sessionTitle"] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain(
      'filename="codex-usage-session-summary.json"',
    );
    expect(await exported.json()).toEqual([{ sessionTitle: "=PRIVATE()", totalTokens: 110 }]);

    const legacy = await app.request(
      "/api/export?dataset=models&format=json&from=2026-07-12&to=2026-07-12",
    );
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toHaveLength(1);
  });
});

function request(preset: ReportPreset): ReportRequest {
  const base = {
    acknowledgeSensitive: [],
    columns: [],
    filters: { from: "2026-07-12", to: "2026-07-12" },
    format: "json" as const,
  };
  switch (preset) {
    case "agent-summary":
      return { ...base, preset };
    case "cost-overview":
      return { ...base, preset };
    case "project-summary":
      return { ...base, preset };
    case "session-summary":
      return { ...base, preset };
    case "turn-summary":
      return { ...base, preset };
  }
}

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-reports-test-"));
  const sessionsDirectory = join(directory, "sessions");
  await mkdir(sessionsDirectory, { recursive: true });
  const databasePath = join(directory, "usage.db");
  const database = createDatabase(databasePath);
  migrateDatabase(database);
  return {
    database,
    directory,
    importer: new SessionImporter(database, sessionsDirectory),
    retention: new RetentionService(database, databasePath, sessionsDirectory),
  };
}

function seedReportData(database: AppDatabase) {
  database
    .insert(projects)
    .values({
      createdAt: 1,
      displayName: "=SUM(A1:A2)",
      displayPath: "/private/report",
      id: "project-report",
      normalizedPath: "/private/report",
      updatedAt: 1,
    })
    .run();
  database
    .insert(sessions)
    .values({
      id: "session-report",
      lastSeenAt: 1,
      projectId: "project-report",
      sourcePath: "/private/report.jsonl",
      startedAt: "2026-07-12T00:00:00.000Z",
      title: "=PRIVATE()",
    })
    .run();
  database
    .insert(sessionAgents)
    .values({
      depth: 0,
      id: "session-report",
      lastSeenAt: 1,
      name: "Private Agent",
      role: "reviewer",
      sessionId: "session-report",
      sourcePath: "/private/report.jsonl",
      threadSource: "user",
    })
    .run();
  database
    .insert(usageEvents)
    .values(usageRow("usage-report", "2026-07-12", 100, 10))
    .run();
  const turnKey = "a".repeat(64);
  database
    .insert(turns)
    .values({
      agentId: "session-report",
      completedAt: "2026-07-12T00:00:01.000Z",
      createdAt: 1,
      durationMs: 1_000,
      id: turnKey,
      lastEventAt: "2026-07-12T00:00:01.000Z",
      localDate: "2026-07-12",
      projectId: "project-report",
      sessionId: "session-report",
      startedAt: "2026-07-12T00:00:00.000Z",
      status: "completed",
      timeToFirstTokenMs: 100,
      turnId: "private-turn",
      updatedAt: 1,
    })
    .run();
  database
    .insert(turnModelUsage)
    .values({
      cachedInputTokens: 20,
      costAttributionMissingCount: 0,
      costUsd: 1,
      inputTokens: 100,
      model: "model-report",
      outputTokens: 10,
      reasoningOutputTokens: 0,
      requestCount: 1,
      totalTokens: 110,
      turnKey,
      unpricedCachedInputTokens: 0,
      unpricedInputTokens: 0,
      unpricedOutputTokens: 0,
      unpricedUsageCount: 0,
    })
    .run();
}

function seedDailyRows(database: AppDatabase, count: number) {
  const start = new Date("2026-06-18T00:00:00.000Z");
  database
    .insert(usageEvents)
    .values(
      Array.from({ length: count - 1 }, (_, offset) => {
        const date = new Date(start);
        date.setUTCDate(date.getUTCDate() + offset);
        const localDate = date.toISOString().slice(0, 10);
        return usageRow(`daily-${offset}`, localDate, 1, 1);
      }),
    )
    .run();
}

function usageRow(id: string, localDate: string, inputTokens: number, outputTokens: number) {
  return {
    agentId: "session-report",
    cachedInputRate: 0.5,
    cachedInputTokens: 0,
    costUsd: 1,
    createdAt: 1,
    id,
    inputRate: 2,
    inputTokens,
    localDate,
    model: "model-report",
    outputRate: 4,
    outputTokens,
    reasoningOutputTokens: 0,
    sessionId: "session-report",
    sourceHash: `hash-${id}`,
    timestamp: `${localDate}T00:00:00.000Z`,
    totalTokens: inputTokens + outputTokens,
  };
}
