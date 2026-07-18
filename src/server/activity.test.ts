import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { getActivity, getActivitySummary, getDataHealth } from "@/server/activity";
import { createApp } from "@/server/app";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import {
  activityDailyRollups,
  activityEvents,
  archivedActivityEventIds,
  importDiagnostics,
  importStates,
  sessionAgents,
  sessions,
  usageDailyRollups,
  usageEvents,
} from "@/server/db/schema";
import { SessionImporter } from "@/server/importer";
import { compactUsage, RetentionService } from "@/server/retention";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("activity import and retention", () => {
  it("migrates populated phase-two rollups without changing token, cost, or membership totals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-usage-product-migration-test-"));
    temporaryDirectories.push(directory);
    const client = new BetterSqlite3(join(directory, "legacy.db"));
    client.pragma("foreign_keys = ON");
    for (let index = 0; index <= 3; index += 1) client.exec(await migrationSql(index));

    client.exec(`
      insert into usage_daily_rollups values
        ('2026-05-01', 'phase-two-model', 'main', 120, 80, 30, 10, 150, 2, 1.25, 0, 0, 0, 0);
      insert into usage_hourly_rollups values
        ('2026-05-01', '09:00', 'phase-two-model', 'main', 120, 80, 30, 10, 150, 2, 1.25, 0, 0, 0, 0);
      insert into usage_rollup_session_memberships values
        ('day', '2026-05-01', 'phase-two-model', 'main', 'legacy-session'),
        ('hour', '2026-05-01T09:00', 'phase-two-model', 'main', 'legacy-session');
    `);
    const before = legacyRollupTotals(client);

    client.exec(await migrationSql(4));
    expect(legacyRollupTotals(client)).toEqual(before);
    expect(
      client.prepare("select distinct project_id as projectId from usage_daily_rollups").all(),
    ).toEqual([{ projectId: "legacy-unknown" }]);

    client.exec(await migrationSql(5));
    client.exec(`
      insert into projects
        (id, display_name, display_path, normalized_path, created_at, updated_at)
      values
        ('phase-two-project', 'Phase two', '/workspace/phase-two', '/workspace/phase-two', 1, 1),
        ('legacy-current-project', 'Legacy current', '/workspace/legacy', '/workspace/legacy', 1, 1);
      insert into sessions
        (id, source_path, cwd, started_at, last_seen_at, source_deleted, title, project_id)
      values
        ('phase-two-session', '/source/phase-two.jsonl', '/workspace/phase-two', null, 1, 0,
         'Phase two session', 'phase-two-project'),
        ('legacy-session', '/source/legacy.jsonl', '/workspace/legacy', null, 1, 0,
         'Legacy session', 'legacy-current-project');
      insert into usage_daily_rollups
        (local_date, model, agent_kind, project_id, input_tokens, cached_input_tokens,
         output_tokens, reasoning_output_tokens, total_tokens, request_count, cost_usd,
         unpriced_usage_count, unpriced_input_tokens, unpriced_cached_input_tokens,
         unpriced_output_tokens)
      values
        ('2026-05-01', 'phase-two-model', 'main', 'phase-two-project', 100, 20, 10, 3,
         110, 1, 0.75, 0, 0, 0, 0);
      insert into usage_rollup_session_memberships
        (bucket_type, bucket_start, model, agent_kind, session_id)
      values
        ('day', '2026-05-01', 'phase-two-model', 'main', 'phase-two-session');
      insert into usage_agent_daily_rollups
        (local_date, agent_id, session_id, model, agent_kind, project_id, input_tokens,
         cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
         request_count, cost_usd, unpriced_usage_count, unpriced_input_tokens,
         unpriced_cached_input_tokens, unpriced_output_tokens)
      values
        ('2026-05-01', 'phase-two-session', 'phase-two-session', 'phase-two-model', 'main',
         'phase-two-project', 100, 20, 10, 3, 110, 1, 0.75, 0, 0, 0, 0);
    `);
    const beforePhaseThree = legacyRollupTotals(client);
    client.exec(await migrationSql(6));
    expect(legacyRollupTotals(client)).toEqual(beforePhaseThree);
    expect(
      client
        .prepare(
          `select distinct project_id as projectId
           from usage_rollup_session_memberships`,
        )
        .all(),
    ).toEqual([{ projectId: "legacy-unknown" }]);

    client.exec(await migrationSql(7));
    expect(legacyRollupTotals(client)).toEqual(beforePhaseThree);
    expect(
      client
        .prepare(
          `select distinct project_id as projectId
           from usage_rollup_session_memberships
           order by project_id`,
        )
        .all(),
    ).toEqual([{ projectId: "legacy-unknown" }, { projectId: "phase-two-project" }]);
    expect(
      client
        .prepare(
          `select project_id as projectId
           from usage_rollup_session_memberships
           where session_id = 'phase-two-session'`,
        )
        .get(),
    ).toEqual({ projectId: "phase-two-project" });
    expect(
      client
        .prepare(
          `select project_id as projectId
           from usage_rollup_session_memberships
           where session_id = 'legacy-session'
           order by bucket_type`,
        )
        .all(),
    ).toEqual([{ projectId: "legacy-unknown" }, { projectId: "legacy-unknown" }]);
    expect(
      client
        .prepare(
          `select project_id as projectId, total_tokens as totalTokens, cost_usd as costUsd
           from usage_agent_daily_rollups
           where agent_id = 'phase-two-session'`,
        )
        .get(),
    ).toEqual({ costUsd: 0.75, projectId: "phase-two-project", totalTokens: 110 });
    expect(client.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(client.pragma("foreign_key_check")).toEqual([]);
    client.close();
  });

  it("adds the phase-three schema without changing legacy usage totals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-usage-activity-migration-test-"));
    temporaryDirectories.push(directory);
    const client = new BetterSqlite3(join(directory, "legacy.db"));
    client.pragma("foreign_keys = ON");

    for (let index = 0; index <= 4; index += 1) {
      client.exec(await migrationSql(index));
    }
    client
      .prepare(
        `insert into sessions
          (id, project_id, source_path, cwd, title, started_at, last_seen_at, source_deleted)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-session", null, "/legacy/source.jsonl", "/legacy", null, null, 1, 0);
    client
      .prepare(
        `insert into usage_events (
          id, session_id, agent_id, source_hash, timestamp, local_date, model,
          input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
          input_rate, cached_input_rate, output_rate, cost_usd, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-event",
        "legacy-session",
        "legacy-session",
        "legacy-hash",
        "2026-07-12T00:00:00.000Z",
        "2026-07-12",
        "gpt-legacy",
        10,
        2,
        3,
        1,
        13,
        2,
        0.5,
        4,
        0.00003,
        1,
      );
    const before = client
      .prepare("select sum(total_tokens) as tokens, sum(cost_usd) as cost from usage_events")
      .get();

    client.exec(await migrationSql(5));
    client
      .prepare(
        `insert into activity_events
          (id, session_id, agent_id, timestamp, local_date, kind, agent_kind, project_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-activity",
        "legacy-session",
        "legacy-session",
        "2026-07-12T00:01:00.000Z",
        "2026-07-12",
        "turn",
        "main",
        "legacy-unknown",
        1,
      );

    client.exec(await migrationSql(6));
    client.exec(await migrationSql(7));
    client.exec(await migrationSql(8));
    client.exec(await migrationSql(9));
    client
      .prepare("insert into import_states (source_path, updated_at) values (?, ?)")
      .run("/legacy/source.jsonl", 1);
    client.exec(await migrationSql(10));
    client.exec(await migrationSql(11));

    expect(
      client
        .prepare("select sum(total_tokens) as tokens, sum(cost_usd) as cost from usage_events")
        .get(),
    ).toEqual(before);
    expect(
      client
        .prepare(
          "select count(*) as count from sqlite_master where type = 'table' and name like 'activity_%'",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      client
        .prepare(
          "select turn_key as turnKey, turn_attribution_version as version from usage_events where id = 'legacy-event'",
        )
        .get(),
    ).toEqual({ turnKey: null, version: 0 });
    expect(
      client
        .prepare(
          "select count(*) as count from sqlite_master where type = 'index' and name = 'activity_events_timestamp_id_index'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      client
        .prepare(
          `select name, "notnull" as "notNull"
           from pragma_table_info('import_states')
           where name in ('source_size', 'source_mtime_ns', 'source_ctime_ns', 'source_file_id')
           order by name`,
        )
        .all(),
    ).toEqual([
      { name: "source_ctime_ns", notNull: 0 },
      { name: "source_file_id", notNull: 0 },
      { name: "source_mtime_ns", notNull: 0 },
      { name: "source_size", notNull: 0 },
    ]);
    expect(
      client
        .prepare(
          `select source_size as sourceSize, source_mtime_ns as sourceMtimeNs,
                  source_ctime_ns as sourceCtimeNs, source_file_id as sourceFileId
           from import_states where source_path = '/legacy/source.jsonl'`,
        )
        .get(),
    ).toEqual({
      sourceCtimeNs: null,
      sourceFileId: null,
      sourceMtimeNs: null,
      sourceSize: null,
    });
    expect(
      client
        .prepare(
          "select turn_key as turnKey, turn_attribution_version as version from activity_events where id = 'legacy-activity'",
        )
        .get(),
    ).toEqual({ turnKey: null, version: 0 });
    expect(
      client
        .prepare(
          `select name from sqlite_master
           where type = 'table' and name in (
             'turns',
             'turn_model_usage',
             'turn_activity_rollups',
             'turn_backfill_state'
           )
           order by name`,
        )
        .all(),
    ).toEqual([
      { name: "turn_activity_rollups" },
      { name: "turn_backfill_state" },
      { name: "turn_model_usage" },
      { name: "turns" },
    ]);
    expect(
      client
        .prepare(
          `select name from sqlite_master
           where type = 'index' and name in (
             'activity_events_turn_timestamp_index',
             'usage_events_turn_timestamp_index'
           )
           order by name`,
        )
        .all(),
    ).toEqual([
      { name: "activity_events_turn_timestamp_index" },
      { name: "usage_events_turn_timestamp_index" },
    ]);
    expect(client.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(client.pragma("foreign_key_check")).toEqual([]);
    client.close();
  });

  it("returns daily usage independently from event kinds and preserves filter semantics", async () => {
    const harness = await createHarness();
    harness.database
      .insert(sessions)
      .values([
        {
          id: "usage-session-a",
          lastSeenAt: 1,
          projectId: "project-a",
          sourcePath: "/usage-a.jsonl",
        },
        {
          id: "usage-session-b",
          lastSeenAt: 1,
          projectId: "project-b",
          sourcePath: "/usage-b.jsonl",
        },
      ])
      .run();
    harness.database
      .insert(sessionAgents)
      .values([
        {
          id: "usage-main-a",
          lastSeenAt: 1,
          sessionId: "usage-session-a",
          sourcePath: "/usage-a.jsonl",
          threadSource: "cli",
        },
        {
          id: "usage-sub-a",
          lastSeenAt: 1,
          sessionId: "usage-session-a",
          sourcePath: "/usage-a-sub.jsonl",
          threadSource: "subagent",
        },
        {
          id: "usage-main-b",
          lastSeenAt: 1,
          sessionId: "usage-session-b",
          sourcePath: "/usage-b.jsonl",
          threadSource: "cli",
        },
      ])
      .run();
    harness.database
      .insert(usageEvents)
      .values([
        usageEventRow({
          agentId: "usage-main-a",
          costUsd: 1.25,
          id: "usage-a-main",
          sessionId: "usage-session-a",
          totalTokens: 100,
        }),
        usageEventRow({
          agentId: "usage-sub-a",
          costUsd: null,
          id: "usage-a-sub",
          sessionId: "usage-session-a",
          totalTokens: 200,
        }),
        usageEventRow({
          agentId: "usage-main-b",
          costUsd: 3,
          id: "usage-b-main",
          sessionId: "usage-session-b",
          totalTokens: 300,
        }),
      ])
      .run();
    harness.database
      .insert(activityEvents)
      .values([
        activityEventRow({
          agentId: "usage-main-a",
          agentKind: "main",
          id: "activity-a-main",
          kind: "shell",
          projectId: "project-a",
          sessionId: "usage-session-a",
        }),
        activityEventRow({
          agentId: "usage-sub-a",
          agentKind: "subagent",
          id: "activity-a-sub",
          kind: "web",
          projectId: "project-a",
          sessionId: "usage-session-a",
        }),
        activityEventRow({
          agentId: "usage-main-b",
          agentKind: "main",
          id: "activity-b-main",
          kind: "shell",
          projectId: "project-b",
          sessionId: "usage-session-b",
        }),
      ])
      .run();
    harness.database
      .insert(usageDailyRollups)
      .values({
        agentKind: "main",
        cachedInputTokens: 0,
        costUsd: 2.5,
        inputTokens: 400,
        localDate: "2026-05-01",
        model: "gpt-archived",
        outputTokens: 0,
        projectId: "project-a",
        reasoningOutputTokens: 0,
        requestCount: 2,
        totalTokens: 400,
        unpricedCachedInputTokens: 0,
        unpricedInputTokens: 50,
        unpricedOutputTokens: 0,
        unpricedUsageCount: 1,
      })
      .run();

    const filters = { from: "2026-05-01", to: "2026-07-12" };
    const summary = getActivitySummary(harness.database, filters);
    expect(summary.dailyUsage).toEqual([
      {
        date: "2026-05-01",
        estimatedCostUsd: 2.5,
        requestCount: 2,
        totalTokens: 400,
        unpricedUsageCount: 1,
      },
      {
        date: "2026-07-12",
        estimatedCostUsd: 4.25,
        requestCount: 3,
        totalTokens: 600,
        unpricedUsageCount: 1,
      },
    ]);

    const shellOnly = getActivitySummary(harness.database, { ...filters, kinds: ["shell"] });
    expect(shellOnly.daily.reduce((total, row) => total + row.count, 0)).toBe(2);
    expect(shellOnly.dailyUsage).toEqual(summary.dailyUsage);

    expect(
      getActivitySummary(harness.database, {
        ...filters,
        agentKind: "main",
        projectId: "project-a",
      }).dailyUsage,
    ).toEqual([
      expect.objectContaining({ date: "2026-05-01", totalTokens: 400 }),
      expect.objectContaining({ date: "2026-07-12", totalTokens: 100 }),
    ]);
    expect(
      getActivitySummary(harness.database, {
        ...filters,
        agentKind: "subagent",
        projectId: "project-a",
      }).dailyUsage,
    ).toEqual([
      {
        date: "2026-07-12",
        estimatedCostUsd: 0,
        requestCount: 1,
        totalTokens: 200,
        unpricedUsageCount: 1,
      },
    ]);
    expect(
      getActivitySummary(harness.database, {
        ...filters,
        sessionId: "usage-session-a",
      }).dailyUsage,
    ).toEqual([
      {
        date: "2026-07-12",
        estimatedCostUsd: 1.25,
        requestCount: 2,
        totalTokens: 300,
        unpricedUsageCount: 1,
      },
    ]);

    const app = createApp(harness.database, harness.importer, harness.retention);
    const response = await app.request("/api/activity/summary?from=2026-05-01&to=2026-07-12");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dailyUsage: summary.dailyUsage });
    const legacy = await (await app.request("/api/activity?from=2026-05-01&to=2026-07-12")).json();
    expect(legacy).not.toHaveProperty("dailyUsage");
  });

  it("imports metadata only and deduplicates append, truncate, rescan, and archive", async () => {
    const harness = await createHarness();
    const incompleteWeb = JSON.stringify(
      event("response_item", "2026-05-01T01:00:03.000Z", {
        id: "web-1",
        query: "private web query",
        type: "web_search_call",
      }),
    ).slice(0, -1);
    const source = await createSource(
      harness.sessionsDirectory,
      [
        sessionMeta("session-activity"),
        eventLine("turn_context", "2026-05-01T01:00:00.000Z", {
          model: "gpt-private",
          private_context: "must never be stored",
        }),
        eventLine("response_item", "2026-05-01T01:00:01.000Z", {
          arguments: '{"cmd":"private command"}',
          call_id: "shell-1",
          name: "exec_command",
          type: "function_call",
        }),
        eventLine("response_item", "2026-05-01T01:00:02.000Z", {
          call_id: "shell-1",
          output: "private tool output",
          type: "function_call_output",
        }),
        "not-json",
      ].join("\n") + `\n${incompleteWeb}`,
    );

    await harness.importer.syncAll();
    expect(harness.database.select().from(activityEvents).all()).toHaveLength(2);
    expect(
      harness.database
        .select()
        .from(importDiagnostics)
        .where(eq(importDiagnostics.sourcePath, source))
        .get(),
    ).toMatchObject({ incompleteLine: true, malformedLines: 1 });

    await appendFile(source, "}\n");
    await harness.importer.syncAll();
    await harness.importer.syncAll();
    const raw = harness.database
      .select()
      .from(activityEvents)
      .orderBy(activityEvents.timestamp)
      .all();
    expect(raw.map((item) => item.kind)).toEqual(["turn", "shell", "web"]);
    expect(JSON.stringify(raw)).not.toMatch(/private|argument|output|query/u);
    expect(
      harness.database
        .select()
        .from(importDiagnostics)
        .where(eq(importDiagnostics.sourcePath, source))
        .get(),
    ).toMatchObject({ incompleteLine: false, malformedLines: 1 });

    await writeFile(
      source,
      `${sessionMeta("session-activity")}\n${eventLine("turn_context", "2026-05-01T01:00:00.000Z", {
        model: "gpt-private",
      })}\n`,
    );
    await harness.importer.syncAll();
    expect(harness.database.select().from(activityEvents).all()).toHaveLength(3);
    expect(
      harness.database
        .select()
        .from(importDiagnostics)
        .where(eq(importDiagnostics.sourcePath, source))
        .get()?.malformedLines,
    ).toBe(0);

    expect(compactUsage(harness.database, new Date("2026-07-13T00:00:00.000Z"))).toMatchObject({
      rawEventsDeleted: 0,
      rollupRowsWritten: 0,
    });
    expect(harness.database.select().from(activityEvents).all()).toHaveLength(0);
    expect(harness.database.select().from(archivedActivityEventIds).all()).toHaveLength(3);
    expect(harness.database.select().from(activityDailyRollups).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventCount: 1, kind: "shell" }),
        expect.objectContaining({ eventCount: 1, kind: "turn" }),
        expect.objectContaining({ eventCount: 1, kind: "web" }),
      ]),
    );

    const archived = getActivity(harness.database, {
      from: "2026-05-01",
      to: "2026-05-01",
    });
    expect(archived.daily.reduce((sum, item) => sum + item.count, 0)).toBe(3);
    expect(archived.timeline).toEqual([]);
    expect(archived.timelineCoverage.status).toBe("none");

    harness.database.update(importStates).set({ lastOffset: 0 }).run();
    await harness.importer.syncAll();
    expect(harness.database.select().from(activityEvents).all()).toHaveLength(0);
    expect(getActivity(harness.database, { from: "2026-05-01", to: "2026-05-01" }).daily).toEqual(
      archived.daily,
    );
  });

  it("paginates activity by timestamp and id and binds cursors to filters", async () => {
    const harness = await createHarness();
    harness.database
      .insert(sessions)
      .values({
        id: "cursor-session",
        lastSeenAt: 1,
        projectId: "cursor-project",
        sourcePath: "/cursor.jsonl",
      })
      .run();
    harness.database
      .insert(activityEvents)
      .values(
        ["a", "b", "c"].map((id) => ({
          agentId: "cursor-session",
          agentKind: "main",
          createdAt: 1,
          id: `cursor-${id}`,
          kind: id === "b" ? "shell" : "turn",
          localDate: "2026-07-12",
          projectId: "cursor-project",
          sessionId: "cursor-session",
          timestamp: "2026-07-12T01:00:00.000Z",
        })),
      )
      .run();
    const app = createApp(harness.database, harness.importer, harness.retention);
    const firstResponse = await app.request(
      "/api/activity/timeline?from=2026-07-12&to=2026-07-12&limit=1",
    );
    const first = (await firstResponse.json()) as {
      hasMore: boolean;
      items: { id: string }[];
      nextCursor: string;
    };
    expect(first).toMatchObject({ hasMore: true, items: [{ id: "cursor-c" }] });
    const secondResponse = await app.request(
      `/api/activity/timeline?from=2026-07-12&to=2026-07-12&limit=1&cursor=${first.nextCursor}`,
    );
    const second = (await secondResponse.json()) as {
      hasMore: boolean;
      items: { id: string }[];
      nextCursor: string;
    };
    expect(second).toMatchObject({ hasMore: true, items: [{ id: "cursor-b" }] });
    const third = await (
      await app.request(
        `/api/activity/timeline?from=2026-07-12&to=2026-07-12&limit=1&cursor=${second.nextCursor}`,
      )
    ).json();
    expect(third).toMatchObject({ hasMore: false, items: [{ id: "cursor-a" }], nextCursor: null });

    expect(
      (
        await app.request(
          `/api/activity/timeline?from=2026-07-12&to=2026-07-12&limit=1&kinds=shell&cursor=${first.nextCursor}`,
        )
      ).status,
    ).toBe(400);
    expect((await app.request("/api/activity/timeline?limit=1&cursor=not-a-cursor")).status).toBe(
      400,
    );
    expect((await app.request("/api/activity/timeline?limit=0")).status).toBe(400);
    expect((await app.request("/api/activity/timeline?limit=201")).status).toBe(400);

    const summary = await app.request("/api/activity/summary?from=2026-07-12&to=2026-07-12");
    expect(await summary.json()).toMatchObject({ timelineTotal: 3 });
    const legacy = await app.request("/api/activity?from=2026-07-12&to=2026-07-12");
    expect(await legacy.json()).toMatchObject({ timeline: expect.any(Array) });
  });

  it("serves project/agent timelines and reports actionable data health", async () => {
    const harness = await createHarness();
    const parent = await createSource(
      harness.sessionsDirectory,
      [
        sessionMeta("session-tree", { cwd: "/workspace/private-project" }),
        eventLine("event_msg", "2026-07-12T01:00:00.000Z", {
          started_at: "2026-07-12T01:00:00.000Z",
          turn_id: "turn-main",
          type: "task_started",
        }),
        tokenLine("2026-07-12T01:01:00.000Z"),
        "malformed-json",
      ].join("\n") + "\n",
    );
    await createSource(
      harness.sessionsDirectory,
      [
        sessionMeta("session-tree", {
          agentId: "agent-child",
          cwd: "/workspace/private-project",
          depth: 2,
          name: "Explorer",
          parentThreadId: "session-tree",
          role: "explorer",
          threadSource: "subagent",
        }),
        eventLine("response_item", "2026-07-12T01:02:00.000Z", {
          call_id: "mcp-1",
          name: "mcp__files__read",
          type: "function_call",
        }),
      ].join("\n") + "\n",
    );

    await harness.importer.syncAll();
    const projectId = harness.database
      .select({ projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, "session-tree"))
      .get()?.projectId;
    expect(projectId).toBeTruthy();
    if (!projectId) throw new Error("Expected the importer to assign a project");

    const childActivity = getActivity(harness.database, {
      agentKind: "subagent",
      from: "2026-07-12",
      projectId,
      sessionId: "session-tree",
      to: "2026-07-12",
    });
    expect(childActivity.timeline).toEqual([
      expect.objectContaining({
        agentId: "agent-child",
        agentKind: "subagent",
        depth: 2,
        kind: "mcp",
        name: "Explorer",
        parentAgentId: "session-tree",
        role: "explorer",
      }),
    ]);

    await rm(parent);
    await harness.importer.syncAll();
    const health = await getDataHealth(harness.database, harness.importer, harness.retention);
    expect(health).toMatchObject({
      activityRawEvents: 2,
      importerError: null,
      malformedLines: 1,
      sourceDeletedSessions: 1,
      sourceScan: {
        lastCompleted: expect.objectContaining({ mode: "inventory" }),
      },
      unknownUsage: 1,
      unpricedUsage: 1,
    });

    const app = createApp(harness.database, harness.importer, harness.retention);
    const response = await app.request(
      `/api/activity?from=2026-07-12&to=2026-07-12&project=${projectId}&agentKind=subagent&session=session-tree`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ timeline: [{ kind: "mcp" }] });
    expect((await app.request("/api/activity?kinds=secret")).status).toBe(400);
    expect((await app.request("/api/data-health")).status).toBe(200);

    const migratedTables = harness.database.all<{ name: string }>(sql`
      select name from sqlite_master
      where type = 'table' and name in (
        'activity_events',
        'activity_daily_rollups',
        'archived_activity_event_ids',
        'import_diagnostics'
      )
    `);
    expect(migratedTables).toHaveLength(4);
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(1);
  });
});

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-activity-test-"));
  temporaryDirectories.push(directory);
  const sessionsDirectory = join(directory, "sessions");
  await mkdir(sessionsDirectory, { recursive: true });
  const databasePath = join(directory, "usage.db");
  const database = createDatabase(databasePath);
  migrateDatabase(database);
  const importer = new SessionImporter(database, sessionsDirectory);
  return {
    database,
    importer,
    retention: new RetentionService(
      database,
      databasePath,
      sessionsDirectory,
      () => new Date("2026-07-13T00:00:00.000Z"),
    ),
    sessionsDirectory,
  } satisfies {
    database: AppDatabase;
    importer: SessionImporter;
    retention: RetentionService;
    sessionsDirectory: string;
  };
}

async function createSource(directory: string, content: string): Promise<string> {
  const nested = join(directory, "2026", "07", "12");
  await mkdir(nested, { recursive: true });
  const source = join(nested, `rollout-${Math.random().toString(16).slice(2)}.jsonl`);
  await writeFile(source, content);
  return source;
}

function usageEventRow({
  agentId,
  costUsd,
  id,
  sessionId,
  totalTokens,
}: {
  agentId: string;
  costUsd: number | null;
  id: string;
  sessionId: string;
  totalTokens: number;
}) {
  return {
    agentId,
    cachedInputTokens: 0,
    costUsd,
    createdAt: 1,
    id,
    inputTokens: totalTokens,
    localDate: "2026-07-12",
    model: "gpt-usage",
    outputTokens: 0,
    reasoningOutputTokens: 0,
    sessionId,
    sourceHash: `${id}-hash`,
    timestamp: "2026-07-12T01:00:00.000Z",
    totalTokens,
  };
}

function activityEventRow({
  agentId,
  agentKind,
  id,
  kind,
  projectId,
  sessionId,
}: {
  agentId: string;
  agentKind: "main" | "subagent";
  id: string;
  kind: "shell" | "web";
  projectId: string;
  sessionId: string;
}) {
  return {
    agentId,
    agentKind,
    createdAt: 1,
    id,
    kind,
    localDate: "2026-07-12",
    projectId,
    sessionId,
    timestamp: "2026-07-12T01:00:00.000Z",
  };
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
  return eventLine("session_meta", "2026-07-12T00:00:00.000Z", {
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
  });
}

function tokenLine(timestamp: string): string {
  return eventLine("event_msg", timestamp, {
    info: {
      last_token_usage: {
        cached_input_tokens: 2,
        input_tokens: 10,
        output_tokens: 3,
        reasoning_output_tokens: 1,
        total_tokens: 13,
      },
    },
    type: "token_count",
  });
}

function eventLine(type: string, timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify(event(type, timestamp, payload));
}

function event(type: string, timestamp: string, payload: Record<string, unknown>) {
  return { payload, timestamp, type };
}

async function migrationSql(index: number): Promise<string> {
  const files = await readdir("drizzle");
  const name = files.find((file) => file.startsWith(`${index.toString().padStart(4, "0")}_`));
  if (!name) throw new Error(`Missing migration ${index}`);
  return (await readFile(join("drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", "");
}

function legacyRollupTotals(client: BetterSqlite3.Database) {
  return {
    daily: client
      .prepare("select sum(total_tokens) as tokens, sum(cost_usd) as cost from usage_daily_rollups")
      .get(),
    hourly: client
      .prepare(
        "select sum(total_tokens) as tokens, sum(cost_usd) as cost from usage_hourly_rollups",
      )
      .get(),
    memberships: client
      .prepare(
        "select bucket_type as bucketType, count(*) as count from usage_rollup_session_memberships group by bucket_type order by bucket_type",
      )
      .all(),
  };
}
