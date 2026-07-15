import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDashboard, upsertModelRate } from "@/server/analytics";
import { createApp } from "@/server/app";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import {
  modelRates,
  projects,
  sessionAgents,
  sessions,
  usageAgentDailyRollups,
  usageDailyRollups,
  usageEvents,
  usageRollupSessionMemberships,
} from "@/server/db/schema";
import { SessionImporter } from "@/server/importer";
import {
  exportDataset,
  getAgents,
  getBudgets,
  getInsights,
  getProjects,
  refreshAlerts,
  saveBudget,
  simulatePricing,
  updateAlert,
} from "@/server/product-analytics";
import { renameProject } from "@/server/projects";
import { RetentionService } from "@/server/retention";

type Harness = Awaited<ReturnType<typeof createHarness>>;

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  seedProductData(harness.database);
});

afterEach(async () => {
  harness.database.$client.close();
  await rm(harness.directory, { force: true, recursive: true });
});

describe("phase 2 product analytics", () => {
  it("compares the previous period and projects the current calendar month", () => {
    const insights = getInsights(
      harness.database,
      { from: "2026-07-12", to: "2026-07-12" },
      fixedNow(),
    );

    expect(insights.previousRange).toEqual({ from: "2026-07-11", to: "2026-07-11" });
    expect(insights.current).toMatchObject({ estimatedCostUsd: 3.5, totalTokens: 3_900 });
    expect(insights.previous).toMatchObject({ estimatedCostUsd: 0, totalTokens: 0 });
    expect(insights.monthlyCostProjection).toBeCloseTo((3.5 / 12) * 31);
    expect(insights.modelCostMover).toMatchObject({ model: "model-b", deltaUsd: 2 });
    expect(insights.anomalies).toEqual([]);
    expect(insights.efficiency).toMatchObject({
      costPerRequest: 3.5 / 3,
      tokensPerSession: 1_950,
    });
  });

  it("aggregates projects and agents while preserving verifiable role metrics", () => {
    const range = { from: "2026-07-12", to: "2026-07-12" };
    const projectResponse = getProjects(harness.database, range, fixedNow());

    expect(projectResponse.projects).toHaveLength(2);
    expect(projectResponse.projects[0]).toMatchObject({
      displayName: "=SUM(A1:A2)",
      estimatedCostUsd: 3,
      id: "project-alpha",
      requestCount: 2,
      sessionCount: 1,
      subagentCostUsd: 2,
      subagentTokens: 2_500,
      totalTokens: 3_600,
    });
    expect(projectResponse.projects[0]?.modelMix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "model-a", totalTokens: 1_100 }),
        expect.objectContaining({ model: "model-b", totalTokens: 2_500 }),
      ]),
    );
    expect(projectResponse.projects[0]).toMatchObject({
      daily: [expect.objectContaining({ date: "2026-07-12", totalTokens: 3_600 })],
      subagentShare: 2_500 / 3_600,
      topSessions: [expect.objectContaining({ sessionId: "session-alpha" })],
    });

    const response = getAgents(harness.database, range, fixedNow());
    expect(response.main).toMatchObject({ requestCount: 2, totalTokens: 1_400 });
    expect(response.subagent).toMatchObject({ requestCount: 1, totalTokens: 2_500 });
    expect(response.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "agent-mapper",
          depth: 1,
          estimatedCostUsd: 2,
          isSubagent: true,
          models: ["model-b"],
          name: "Mapper",
          parentAgentId: "session-alpha",
          projectIds: ["project-alpha"],
          requestCount: 1,
          role: "explorer",
          sessionCount: 1,
          totalTokens: 2_500,
        }),
      ]),
    );

    const filtered = getAgents(
      harness.database,
      { ...range, depth: 1, projectId: "project-alpha", role: "explorer" },
      fixedNow(),
    );
    expect(filtered.agents.map((agent) => agent.agentId)).toEqual(["agent-mapper"]);
    expect(filtered.main).toMatchObject({ requestCount: 0, totalTokens: 0 });
    expect(filtered.subagent).toMatchObject({ requestCount: 1, totalTokens: 2_500 });
  });

  it("renames projects without changing their identity or aggregate usage", () => {
    const renamed = renameProject(harness.database, "project-alpha", "Alpha mới");
    expect(renamed).toMatchObject({ displayName: "Alpha mới", id: "project-alpha" });
    expect(renameProject(harness.database, "missing", "Không tồn tại")).toBeNull();

    expect(
      getProjects(
        harness.database,
        { from: "2026-07-12", to: "2026-07-12" },
        fixedNow(),
      ).projects.find((project) => project.id === "project-alpha"),
    ).toMatchObject({ displayName: "Alpha mới", totalTokens: 3_600 });
  });

  it("keeps project and agent totals available from archived daily rollups", () => {
    const aggregate = {
      cachedInputTokens: 200,
      costUsd: 0.25,
      inputTokens: 300,
      outputTokens: 50,
      reasoningOutputTokens: 20,
      requestCount: 2,
      totalTokens: 350,
      unpricedCachedInputTokens: 0,
      unpricedInputTokens: 0,
      unpricedOutputTokens: 0,
      unpricedUsageCount: 0,
    };
    harness.database
      .insert(usageAgentDailyRollups)
      .values({
        ...aggregate,
        agentId: "agent-mapper",
        agentKind: "subagent",
        localDate: "2026-04-01",
        model: "model-b",
        projectId: "project-alpha",
        sessionId: "session-alpha",
      })
      .run();
    harness.database
      .insert(usageDailyRollups)
      .values({
        ...aggregate,
        agentKind: "subagent",
        localDate: "2026-04-01",
        model: "model-b",
        projectId: "project-alpha",
      })
      .run();
    harness.database
      .insert(usageRollupSessionMemberships)
      .values({
        agentKind: "subagent",
        bucketStart: "2026-04-01",
        bucketType: "day",
        model: "model-b",
        projectId: "project-alpha",
        sessionId: "session-alpha",
      })
      .run();

    const range = { from: "2026-04-01", to: "2026-04-01" };
    expect(getAgents(harness.database, range, fixedNow())).toMatchObject({
      agents: [
        expect.objectContaining({
          agentId: "agent-mapper",
          estimatedCostUsd: 0.25,
          requestCount: 2,
          totalTokens: 350,
        }),
      ],
      subagent: expect.objectContaining({
        estimatedCostUsd: 0.25,
        requestCount: 2,
        sessionCount: 1,
        totalTokens: 350,
      }),
    });
    expect(getProjects(harness.database, range, fixedNow()).projects).toEqual([
      expect.objectContaining({
        estimatedCostUsd: 0.25,
        id: "project-alpha",
        totalTokens: 350,
      }),
    ]);
  });

  it("keeps legacy main/subagent totals when per-agent rollups do not exist yet", () => {
    const base = {
      cachedInputTokens: 60,
      costUsd: 0.4,
      inputTokens: 100,
      localDate: "2026-03-01",
      outputTokens: 20,
      projectId: "legacy-unknown",
      reasoningOutputTokens: 5,
      requestCount: 1,
      totalTokens: 120,
      unpricedCachedInputTokens: 0,
      unpricedInputTokens: 0,
      unpricedOutputTokens: 0,
      unpricedUsageCount: 0,
    };
    harness.database
      .insert(usageDailyRollups)
      .values([
        { ...base, agentKind: "main", model: "legacy-main" },
        {
          ...base,
          agentKind: "subagent",
          cachedInputTokens: 120,
          costUsd: 0.8,
          inputTokens: 200,
          model: "legacy-subagent",
          outputTokens: 40,
          totalTokens: 240,
        },
      ])
      .run();
    harness.database
      .insert(usageRollupSessionMemberships)
      .values([
        {
          agentKind: "main",
          bucketStart: "2026-03-01",
          bucketType: "day",
          model: "legacy-main",
          sessionId: "session-alpha",
        },
        {
          agentKind: "subagent",
          bucketStart: "2026-03-01",
          bucketType: "day",
          model: "legacy-subagent",
          sessionId: "session-alpha",
        },
      ])
      .run();

    const response = getAgents(
      harness.database,
      { from: "2026-03-01", to: "2026-03-01" },
      fixedNow(),
    );
    expect(response.agents).toEqual([]);
    expect(response.main).toMatchObject({ requestCount: 1, sessionCount: 1, totalTokens: 120 });
    expect(response.subagent).toMatchObject({
      requestCount: 1,
      sessionCount: 1,
      totalTokens: 240,
    });
    expect(response.daily).toEqual([
      expect.objectContaining({
        date: "2026-03-01",
        main: expect.objectContaining({ totalTokens: 120 }),
        subagent: expect.objectContaining({ totalTokens: 240 }),
      }),
    ]);
    expect(
      getDashboard(
        harness.database,
        { from: "2026-03-01", projectId: "legacy-unknown", to: "2026-03-01" },
        fixedNow(),
      ).kpis,
    ).toMatchObject({ sessionCount: 1, totalTokens: 360 });
    expect(
      getDashboard(
        harness.database,
        { from: "2026-03-01", projectId: "project-alpha", to: "2026-03-01" },
        fixedNow(),
      ).kpis,
    ).toMatchObject({ sessionCount: 0, totalTokens: 0 });
  });

  it("stores budgets, emits idempotent threshold alerts, and supports alert state", () => {
    expect(getBudgets(harness.database)).toEqual([
      expect.objectContaining({
        enabled: false,
        limitUsd: 0,
        period: "daily",
        warningThresholds: [50, 80, 100],
      }),
      expect.objectContaining({
        enabled: false,
        limitUsd: 0,
        period: "monthly",
        warningThresholds: [50, 80, 100],
      }),
    ]);

    saveBudget(harness.database, {
      enabled: true,
      limitUsd: 2,
      period: "daily",
      warningThresholds: [50, 80, 100],
    });
    const first = refreshAlerts(harness.database, fixedNow()).filter(
      (alert) => alert.type === "budget",
    );
    const second = refreshAlerts(harness.database, fixedNow()).filter(
      (alert) => alert.type === "budget",
    );

    expect(first).toHaveLength(3);
    expect(second.map((alert) => alert.id)).toEqual(first.map((alert) => alert.id));
    expect(first.map((alert) => alert.severity)).toEqual(
      expect.arrayContaining(["critical", "info", "warning"]),
    );

    const seen = updateAlert(harness.database, first[0]!.id, "seen");
    expect(seen?.seenAt).not.toBeNull();
    const dismissed = updateAlert(harness.database, first[0]!.id, "dismiss");
    expect(dismissed?.dismissedAt).not.toBeNull();
    expect(updateAlert(harness.database, "missing", "seen")).toBeNull();
  });

  it("simulates replacement prices without mutating rate cards or usage snapshots", () => {
    const ratesBefore = harness.database.select().from(modelRates).all();
    const eventsBefore = harness.database
      .select({ costUsd: usageEvents.costUsd, id: usageEvents.id })
      .from(usageEvents)
      .all();

    const result = simulatePricing(harness.database, {
      from: "2026-07-12",
      rates: [
        { cachedInputRate: 1, inputRate: 10, model: "model-a", outputRate: 20 },
        { cachedInputRate: 0.5, inputRate: 5, model: "model-b", outputRate: 10 },
        { cachedInputRate: 0, inputRate: 0, model: "model-c", outputRate: 0 },
      ],
      to: "2026-07-12",
    });

    expect(result.currentCostUsd).toBe(3.5);
    expect(result.simulatedCostUsd).toBeCloseTo(0.0189);
    expect(result.deltaUsd).toBeCloseTo(-3.4811);
    expect(
      simulatePricing(harness.database, {
        from: "2026-07-12",
        rates: [{ cachedInputRate: 1, inputRate: 10, model: "model-a", outputRate: 20 }],
        to: "2026-07-12",
      }).simulatedCostUsd,
    ).toBeCloseTo(2.5084);
    expect(harness.database.select().from(modelRates).all()).toEqual(ratesBefore);
    expect(
      harness.database
        .select({ costUsd: usageEvents.costUsd, id: usageEvents.id })
        .from(usageEvents)
        .all(),
    ).toEqual(eventsBefore);
  });

  it("exports the exact filtered dataset as JSON or injection-safe CSV", () => {
    const json = exportDataset(
      harness.database,
      "models",
      { from: "2026-07-12", projectId: "project-alpha", to: "2026-07-12" },
      "json",
    );
    expect(json).toMatchObject({
      contentType: "application/json",
      filename: "codex-usage-models.json",
    });
    expect(JSON.parse(json.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "model-a", totalTokens: 1_100 }),
        expect.objectContaining({ model: "model-b", totalTokens: 2_500 }),
      ]),
    );

    const csv = exportDataset(
      harness.database,
      "projects",
      { from: "2026-07-12", to: "2026-07-12" },
      "csv",
    );
    expect(csv.contentType).toBe("text/csv; charset=utf-8");
    expect(csv.body).toContain('"displayName"');
    expect(csv.body).toContain('"\'=SUM(A1:A2)"');

    renameProject(harness.database, "project-alpha", "\t=SUM(A1:A2)");
    expect(
      exportDataset(harness.database, "projects", { from: "2026-07-12", to: "2026-07-12" }, "csv")
        .body,
    ).toContain('"\'\t=SUM(A1:A2)"');

    seedManySessions(harness.database, 101);
    const sessionsJson = exportDataset(
      harness.database,
      "sessions",
      { from: "2026-07-12", to: "2026-07-12" },
      "json",
    );
    expect(JSON.parse(sessionsJson.body)).toHaveLength(103);
  });
});

describe("phase 2 API", () => {
  it("supports session search, server-side sort, pagination, and validation", async () => {
    const app = createApp(harness.database, harness.importer, harness.retention);
    const page = await app.request(
      "/api/sessions?from=2026-07-12&to=2026-07-12&page=1&pageSize=1&sort=tokens&order=desc",
    );
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      page: 1,
      pageSize: 1,
      sessions: [expect.objectContaining({ sessionId: "session-alpha", totalTokens: 3_600 })],
      total: 2,
    });

    const byWorkspace = await app.request(
      "/api/sessions?from=2026-07-12&to=2026-07-12&q=beta-workspace",
    );
    expect(await byWorkspace.json()).toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "session-beta" })],
      total: 1,
    });
    const byAgent = await app.request(
      "/api/sessions?from=2026-07-12&to=2026-07-12&q=mapper&hasSubagents=true",
    );
    expect(await byAgent.json()).toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "session-alpha" })],
      total: 1,
    });

    expect((await app.request("/api/sessions?page=0")).status).toBe(400);
    expect((await app.request("/api/sessions?pageSize=101")).status).toBe(400);
    expect((await app.request("/api/sessions?sort=unknown")).status).toBe(400);
    expect((await app.request("/api/sessions?hasSubagents=maybe")).status).toBe(400);
  });

  it("exposes projects and agents with strict validation", async () => {
    const app = createApp(harness.database, harness.importer, harness.retention);
    const projectResponse = await app.request(
      "/api/projects?from=2026-07-12&to=2026-07-12&project=project-alpha",
    );
    expect(projectResponse.status).toBe(200);
    expect(await projectResponse.json()).toMatchObject({
      projects: [expect.objectContaining({ id: "project-alpha", totalTokens: 3_600 })],
    });

    const renamed = await app.request("/api/projects/project-alpha", {
      body: JSON.stringify({ displayName: "Alpha API" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      project: expect.objectContaining({ displayName: "Alpha API", id: "project-alpha" }),
    });
    expect(
      (
        await app.request("/api/projects/project-alpha", {
          body: JSON.stringify({ displayName: " " }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/projects/missing", {
          body: JSON.stringify({ displayName: "Missing" }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        })
      ).status,
    ).toBe(404);

    const agentsResponse = await app.request(
      "/api/agents?from=2026-07-12&to=2026-07-12&role=explorer&depth=1",
    );
    expect(agentsResponse.status).toBe(200);
    expect(await agentsResponse.json()).toMatchObject({
      agents: [expect.objectContaining({ agentId: "agent-mapper" })],
    });
    expect((await app.request("/api/agents?depth=-1")).status).toBe(400);
    expect((await app.request(`/api/agents?role=${"x".repeat(101)}`)).status).toBe(400);
    expect((await app.request("/api/projects?from=invalid")).status).toBe(400);
    expect((await app.request(`/api/projects?model=${"x".repeat(161)}`)).status).toBe(400);
    expect((await app.request(`/api/projects?project=${"x".repeat(161)}`)).status).toBe(400);
    expect(
      (
        await app.request(
          `/api/projects?models=${Array.from({ length: 101 }, (_, index) => `m${index}`).join(",")}`,
        )
      ).status,
    ).toBe(400);
  });

  it("validates budgets and alert actions", async () => {
    const app = createApp(harness.database, harness.importer, harness.retention);
    const saved = await app.request("/api/budgets", {
      body: JSON.stringify({
        enabled: true,
        limitUsd: 2,
        period: "daily",
        warningThresholds: [100, 50, 50],
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      budget: { period: "daily", warningThresholds: [50, 100] },
    });
    expect((await app.request("/api/budgets")).status).toBe(200);
    expect(
      (
        await app.request("/api/budgets", {
          body: JSON.stringify({
            enabled: true,
            limitUsd: -1,
            period: "yearly",
            warningThresholds: [],
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/budgets", {
          body: JSON.stringify({
            enabled: true,
            limitUsd: 0,
            period: "daily",
            warningThresholds: [50, 80, 100],
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        })
      ).status,
    ).toBe(400);

    const [alert] = refreshAlerts(harness.database, fixedNow()).filter(
      (value) => value.type === "budget",
    );
    expect(alert).toBeDefined();
    const seen = await app.request(`/api/alerts/${alert!.id}`, {
      body: JSON.stringify({ action: "seen" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    expect(seen.status).toBe(200);
    expect(await seen.json()).toMatchObject({ alert: expect.objectContaining({ id: alert!.id }) });
    expect(
      (
        await app.request(`/api/alerts/${alert!.id}`, {
          body: JSON.stringify({ action: "delete" }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/alerts/missing", {
          body: JSON.stringify({ action: "seen" }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        })
      ).status,
    ).toBe(404);
  });

  it("validates pricing simulation and export responses without mutation", async () => {
    const app = createApp(harness.database, harness.importer, harness.retention);
    const ratesBefore = harness.database.select().from(modelRates).all();
    const simulation = await app.request("/api/pricing/simulate", {
      body: JSON.stringify({
        from: "2026-07-12",
        rates: [{ cachedInputRate: 1, inputRate: 10, model: "model-a", outputRate: 20 }],
        to: "2026-07-12",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(simulation.status).toBe(200);
    expect(await simulation.json()).toMatchObject({ currentCostUsd: 3.5 });
    expect(harness.database.select().from(modelRates).all()).toEqual(ratesBefore);

    expect(
      (
        await app.request("/api/pricing/simulate", {
          body: JSON.stringify({
            from: "2026-07-13",
            rates: [{ cachedInputRate: 0, inputRate: -1, model: "bad", outputRate: 0 }],
            to: "2026-07-12",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
    ).toBe(400);

    const exported = await app.request(
      "/api/export?dataset=models&format=json&from=2026-07-12&to=2026-07-12&project=project-alpha",
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain(
      'filename="codex-usage-models.json"',
    );
    expect(exported.headers.get("content-type")).toContain("application/json");
    expect(await exported.json()).toHaveLength(2);

    const filteredSessions = await app.request(
      "/api/export?dataset=sessions&format=json&from=2026-07-12&to=2026-07-12&q=beta-workspace",
    );
    expect(filteredSessions.status).toBe(200);
    expect(await filteredSessions.json()).toEqual([
      expect.objectContaining({ sessionId: "session-beta" }),
    ]);
    const filteredAgents = await app.request(
      "/api/export?dataset=agents&format=json&from=2026-07-12&to=2026-07-12&role=explorer&depth=1",
    );
    expect(filteredAgents.status).toBe(200);
    expect(await filteredAgents.json()).toEqual([
      expect.objectContaining({ agentId: "agent-mapper" }),
    ]);
    expect((await app.request("/api/export?dataset=invalid")).status).toBe(400);
    expect((await app.request("/api/export?dataset=models&format=xml")).status).toBe(400);
    const missing = await app.request("/api/not-a-real-endpoint");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "API route not found" });
  });
});

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-product-test-"));
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

function seedProductData(database: AppDatabase) {
  const timestamp = Date.parse("2026-07-12T00:00:00.000Z");
  database
    .insert(projects)
    .values([
      {
        createdAt: timestamp,
        displayName: "=SUM(A1:A2)",
        displayPath: "/workspace/alpha",
        id: "project-alpha",
        normalizedPath: "/workspace/alpha",
        updatedAt: timestamp,
      },
      {
        createdAt: timestamp,
        displayName: "Beta",
        displayPath: "/workspace/beta-workspace",
        id: "project-beta",
        normalizedPath: "/workspace/beta-workspace",
        updatedAt: timestamp,
      },
    ])
    .run();
  database
    .insert(sessions)
    .values([
      {
        cwd: "/workspace/alpha",
        id: "session-alpha",
        lastSeenAt: timestamp,
        projectId: "project-alpha",
        sourcePath: "/sources/alpha.jsonl",
        startedAt: "2026-07-12T01:00:00.000Z",
        title: "Alpha dashboard",
      },
      {
        cwd: "/workspace/beta-workspace",
        id: "session-beta",
        lastSeenAt: timestamp,
        projectId: "project-beta",
        sourcePath: "/sources/beta.jsonl",
        startedAt: "2026-07-12T02:00:00.000Z",
        title: "Beta audit",
      },
    ])
    .run();
  database
    .insert(sessionAgents)
    .values([
      {
        depth: 0,
        id: "session-alpha",
        lastSeenAt: timestamp,
        sessionId: "session-alpha",
        sourcePath: "/sources/alpha.jsonl",
        threadSource: "user",
      },
      {
        depth: 1,
        id: "agent-mapper",
        lastSeenAt: timestamp,
        name: "Mapper",
        parentThreadId: "session-alpha",
        role: "explorer",
        sessionId: "session-alpha",
        sourcePath: "/sources/alpha-mapper.jsonl",
        taskSummary: "Map source files",
        threadSource: "subagent",
      },
      {
        depth: 0,
        id: "session-beta",
        lastSeenAt: timestamp,
        sessionId: "session-beta",
        sourcePath: "/sources/beta.jsonl",
        threadSource: "user",
      },
    ])
    .run();
  database
    .insert(usageEvents)
    .values([
      usageEvent({
        agentId: "session-alpha",
        cachedInputTokens: 400,
        costUsd: 1,
        id: "event-alpha-main",
        inputTokens: 1_000,
        model: "model-a",
        outputTokens: 100,
        sessionId: "session-alpha",
        timestamp: "2026-07-12T01:00:00.000Z",
      }),
      usageEvent({
        agentId: "agent-mapper",
        cachedInputTokens: 1_000,
        costUsd: 2,
        id: "event-alpha-subagent",
        inputTokens: 2_000,
        model: "model-b",
        outputTokens: 500,
        sessionId: "session-alpha",
        timestamp: "2026-07-12T01:30:00.000Z",
      }),
      usageEvent({
        agentId: "session-beta",
        cachedInputTokens: 0,
        costUsd: 0.5,
        id: "event-beta-main",
        inputTokens: 250,
        model: "model-c",
        outputTokens: 50,
        sessionId: "session-beta",
        timestamp: "2026-07-12T02:00:00.000Z",
      }),
    ])
    .run();
  for (const model of ["model-a", "model-b", "model-c"]) {
    upsertModelRate(database, {
      cachedInputRate: 0.5,
      inputRate: 2,
      model,
      outputRate: 4,
    });
  }
}

function seedManySessions(database: AppDatabase, count: number) {
  const timestamp = Date.parse("2026-07-12T03:00:00.000Z");
  const values = Array.from({ length: count }, (_, index) => ({
    agentId: `bulk-session-${index}`,
    id: `bulk-event-${index}`,
    sessionId: `bulk-session-${index}`,
  }));
  database
    .insert(sessions)
    .values(
      values.map(({ sessionId }) => ({
        cwd: "/workspace/alpha",
        id: sessionId,
        lastSeenAt: timestamp,
        projectId: "project-alpha",
        sourcePath: `/sources/${sessionId}.jsonl`,
        startedAt: "2026-07-12T03:00:00.000Z",
        title: `Bulk ${sessionId}`,
      })),
    )
    .run();
  database
    .insert(sessionAgents)
    .values(
      values.map(({ agentId, sessionId }) => ({
        depth: 0,
        id: agentId,
        lastSeenAt: timestamp,
        sessionId,
        sourcePath: `/sources/${sessionId}.jsonl`,
        threadSource: "user",
      })),
    )
    .run();
  database
    .insert(usageEvents)
    .values(
      values.map(({ agentId, id, sessionId }, index) =>
        usageEvent({
          agentId,
          cachedInputTokens: 0,
          costUsd: 0.01,
          id,
          inputTokens: 10,
          model: "model-a",
          outputTokens: 1,
          sessionId,
          timestamp: `2026-07-12T03:${String(index % 60).padStart(2, "0")}:00.000Z`,
        }),
      ),
    )
    .run();
}

function usageEvent(value: {
  agentId: string;
  cachedInputTokens: number;
  costUsd: number;
  id: string;
  inputTokens: number;
  model: string;
  outputTokens: number;
  sessionId: string;
  timestamp: string;
}): typeof usageEvents.$inferInsert {
  return {
    ...value,
    cachedInputRate: 0.5,
    createdAt: Date.parse(value.timestamp),
    inputRate: 2,
    localDate: "2026-07-12",
    outputRate: 4,
    reasoningOutputTokens: Math.floor(value.outputTokens / 2),
    sourceHash: `hash-${value.id}`,
    totalTokens: value.inputTokens + value.outputTokens,
  };
}

function fixedNow() {
  return new Date("2026-07-12T12:00:00.000Z");
}
