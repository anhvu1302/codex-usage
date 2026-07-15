import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { getActivity, getDataHealth } from "@/server/activity";
import { createApp } from "@/server/app";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import {
  activityDailyRollups,
  activityEvents,
  archivedActivityEventIds,
  importDiagnostics,
  importStates,
  sessions,
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
    client.close();
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
