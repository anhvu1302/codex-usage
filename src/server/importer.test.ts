import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  backfillUnpricedUsage,
  getDashboard,
  getKnownModels,
  getModelRates,
  getSessions,
  upsertModelRate,
} from "@/server/analytics";
import { createApp } from "@/server/app";
import { getConfig } from "@/server/config";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import { sessions, usageEvents } from "@/server/db/schema";
import {
  calculateCost,
  normalizeTokenUsage,
  SessionImporter,
  toLocalDate,
} from "@/server/importer";

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
    expect(
      getConfig({
        CODEX_SESSIONS_DIR: "/tmp/sessions",
        CODEX_USAGE_DB: "/tmp/usage.db",
        PORT: "9123",
      }),
    ).toEqual({
      databasePath: "/tmp/usage.db",
      port: 9123,
      sessionsDirectory: "/tmp/sessions",
    });
  });
});

describe("session importer", () => {
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
    await harness.importer.syncAll();
    const session = harness.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, "session-idempotent"))
      .get();
    expect(session?.sourceDeleted).toBe(true);
    expect(harness.database.select().from(usageEvents).all()).toHaveLength(3);
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
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-parent"),
      userMessage("Tạo dashboard usage theo ngày"),
      turnContext("gpt-parent"),
      tokenCount("2026-07-12T01:00:00.000Z", 100, 20, 10, 4),
    ]);
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-parent", {
        agentId: "agent-mapper",
        depth: 1,
        name: "Mapper",
        parentThreadId: "session-parent",
        role: "explorer",
        threadSource: "subagent",
      }),
      userMessage("Khảo sát source code dashboard"),
      turnContext("gpt-child"),
      tokenCount("2026-07-12T01:01:00.000Z", 200, 50, 30, 10),
    ]);

    expect((await harness.importer.syncAll()).recordsInserted).toBe(2);
    expect((await harness.importer.syncAll()).recordsInserted).toBe(0);

    const usage = harness.database.select().from(usageEvents).orderBy(usageEvents.timestamp).all();
    expect(usage.map((event) => event.agentId)).toEqual(["session-parent", "agent-mapper"]);

    const session = getSessions(harness.database, {
      from: "2026-07-12",
      to: "2026-07-12",
    })[0];
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

  it("deduplicates mirrored subagent token snapshots using cumulative usage", async () => {
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

    expect((await harness.importer.syncAll()).recordsInserted).toBe(1);
    const events = harness.database.select().from(usageEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: "session-mirrored",
      localDate: "2026-07-11",
      timestamp: "2026-07-11T16:50:00.000Z",
      totalTokens: 110,
    });
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
    expect(getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" })[0]?.title).toBe(
      "Tên task chuẩn trong Codex",
    );
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
          getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" })[0]?.title,
        ).toBe("Tên đổi trong Codex");
      },
      { interval: 50, timeout: 3_000 },
    );
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
      { date: "2026-07-12", model: "gpt-api", totalTokens: 225 },
    ]);
    expect(dashboard.hourly).toHaveLength(24);
    expect(dashboard.hourly.find((hour) => hour.hour === "09:00")).toMatchObject({
      requestCount: 1,
      totalTokens: 225,
    });
    expect(dashboard.hourlyModels).toEqual([{ hour: "09:00", model: "gpt-api", totalTokens: 225 }]);
    expect(
      getDashboard(harness.database, { from: "2026-07-11", to: "2026-07-12" }).hourlyModels,
    ).toEqual([]);
    expect(
      getDashboard(harness.database, { from: "2026-07-13", model: "missing", to: "2026-07-13" })
        .kpis.totalTokens,
    ).toBe(0);
    expect(
      getSessions(harness.database, { from: "2026-07-12", to: "2026-07-12" })[0],
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

    const app = createApp(harness.database, harness.importer);
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/status")).status).toBe(200);
    expect((await app.request("/api/dashboard")).status).toBe(200);
    expect((await app.request("/api/models")).status).toBe(200);
    expect((await app.request("/api/rates")).status).toBe(200);
    expect((await app.request("/api/sessions?from=2026-07-12&to=2026-07-12")).status).toBe(200);
    expect((await app.request("/api/sync", { method: "POST" })).status).toBe(200);
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
    ).toBe(500);
    expect((await app.request("/api/rates/%20/backfill", { method: "POST" })).status).toBe(400);
    expect((await app.request("/api/rates/gpt-api/backfill", { method: "POST" })).status).toBe(200);
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

  it("treats a missing sessions root as an empty source", async () => {
    const harness = await createHarness();
    const missing = new SessionImporter(
      harness.database,
      join(harness.sessionsDirectory, "does-not-exist"),
    );
    await expect(missing.syncAll()).resolves.toMatchObject({ error: null, filesProcessed: 0 });
  });

  it("reclassifies an inferred model and backfills its existing rate during sync", async () => {
    const harness = await createHarness();
    upsertModelRate(harness.database, {
      cachedInputRate: 0.5,
      inputRate: 2,
      model: "gpt-reconciled",
      outputRate: 4,
    });
    await createSessionFile(harness.sessionsDirectory, [
      sessionMeta("session-reconciled"),
      turnContext("gpt-reconciled"),
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

    const status = await harness.importer.syncAll();
    const event = harness.database
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.sessionId, "session-reconciled"))
      .get();
    expect(status).toMatchObject({ recordsBackfilled: 1, recordsReclassified: 1 });
    expect(event).toMatchObject({ costUsd: 0.00021, model: "gpt-reconciled" });
  });
});

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-test-"));
  temporaryDirectories.push(directory);
  const sessionsDirectory = join(directory, "sessions");
  await mkdir(sessionsDirectory, { recursive: true });
  const database = createDatabase(join(directory, "usage.db"));
  migrateDatabase(database);
  return {
    database,
    importer: new SessionImporter(database, sessionsDirectory),
    sessionsDirectory,
  } satisfies { database: AppDatabase; importer: SessionImporter; sessionsDirectory: string };
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
      cwd: "/workspace",
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

function turnContext(model: string): string {
  return JSON.stringify({
    payload: { model },
    timestamp: "2026-07-12T00:00:01.000Z",
    type: "turn_context",
  });
}

function tokenCount(
  timestamp: string,
  input: number,
  cached: number,
  output: number,
  reasoning: number,
  cumulativeUsage?: { cached: number; input: number; output: number; reasoning: number },
): string {
  return JSON.stringify({
    payload: {
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
