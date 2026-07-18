import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  getDailyMinuteReport,
  getDashboard,
  getSessionAnomalyRows,
  getSessions,
} from "@/server/analytics";
import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import {
  getAgentsPage,
  getAgentsSummary,
  getAlertFeed,
  getOverview,
  getProjectsPage,
  getProjectsSummary,
} from "@/server/product-analytics";
import type { DashboardFilters } from "@/shared/types";

type FixtureOptions = { agents: number; projects: number; sessions: number; usageEvents: number };
type Sample = {
  durationMs: number;
  heapAfterBytes: number;
  heapBeforeBytes: number;
  heapDeltaBytes: number;
  responseBytes: number;
  rssAfterBytes: number;
  rssBeforeBytes: number;
  rssDeltaBytes: number;
  statements: number;
};

const fixture: FixtureOptions = {
  agents: 1_000,
  projects: 100,
  sessions: 5_000,
  usageEvents: 50_000,
};
const root = await mkdtemp(join(tmpdir(), "codex-usage-analytics-benchmark-"));
const databasePath = join(root, "usage.db");
const outputDirectory = join(process.cwd(), ".local", "benchmarks");
let statementCount = 0;
let database: AppDatabase | null = null;

try {
  database = createDatabase(databasePath, { onStatement: () => (statementCount += 1) });
  migrateDatabase(database);
  const exactCounts = seedFixture(database, fixture);
  for (const [name, expected] of Object.entries(fixture)) {
    if (exactCounts[name as keyof typeof exactCounts] !== expected) {
      throw new Error(`Fixture ${name} count is not exact`);
    }
  }
  const filters: DashboardFilters = { from: "2026-07-01", to: "2026-07-30" };
  const sevenDayFilters: DashboardFilters = { from: "2026-07-24", to: "2026-07-30" };
  const now = new Date("2026-07-30T12:00:00.000+07:00");
  const scenarios = {
    agents: () => ({
      page: getAgentsPage(database!, {
        ...filters,
        order: "desc",
        page: 1,
        pageSize: 50,
        sort: "tokens",
      }),
      summary: getAgentsSummary(database!, filters, now),
    }),
    alerts: () => getAlertFeed(database!, now),
    dashboard7Days: () => getDashboard(database!, sevenDayFilters, now),
    dailyMinutes: () =>
      getDailyMinuteReport(database!, { from: "2026-07-30", to: "2026-07-30" }, now),
    anomaly7Days: () => getSessionAnomalyRows(database!, sevenDayFilters, now),
    anomalyBaseline7Days: () =>
      getSessionAnomalyRows(database!, { from: "2026-07-10", to: "2026-07-23" }, now),
    overview: () => getOverview(database!, filters, now),
    overview7Days: () => getOverview(database!, sevenDayFilters, now),
    projects: () => ({
      page: getProjectsPage(database!, { ...filters, page: 1, pageSize: 50 }),
      summary: getProjectsSummary(database!, filters),
    }),
    sessions: () =>
      getSessions(
        database!,
        { ...filters, order: "desc", page: 1, pageSize: 20, sort: "lastActivity" },
        now,
      ),
  };
  for (const run of Object.values(scenarios)) run();
  const measurements = Object.fromEntries(
    Object.entries(scenarios).map(([name, run]) => [
      name,
      measure(
        run,
        () => statementCount,
        () => (statementCount = 0),
      ),
    ]),
  );
  const result = {
    configuration: fixture,
    exactCounts,
    measurementNote:
      "Synthetic fixture only. Duration and memory have no CI wall-clock threshold; compare medians on the same machine. Statement count excludes fixture setup and warm-up.",
    measurements,
  };
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = join(
    outputDirectory,
    `analytics-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, ...result }, null, 2)}\n`);
} finally {
  database?.$client.close();
  await rm(root, { force: true, recursive: true });
}

function measure(run: () => unknown, readStatements: () => number, resetStatements: () => void) {
  const samples: Sample[] = [];
  for (let index = 0; index < 3; index += 1) {
    resetStatements();
    const before = process.memoryUsage();
    const startedAt = performance.now();
    const result = run();
    const durationMs = performance.now() - startedAt;
    const after = process.memoryUsage();
    samples.push({
      durationMs: round(durationMs),
      heapAfterBytes: after.heapUsed,
      heapBeforeBytes: before.heapUsed,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      responseBytes: Buffer.byteLength(JSON.stringify(result)),
      rssAfterBytes: after.rss,
      rssBeforeBytes: before.rss,
      rssDeltaBytes: after.rss - before.rss,
      statements: readStatements(),
    });
  }
  return {
    medianDurationMs: median(samples.map((sample) => sample.durationMs)),
    medianHeapDeltaBytes: median(samples.map((sample) => sample.heapDeltaBytes)),
    medianResponseBytes: median(samples.map((sample) => sample.responseBytes)),
    medianRssDeltaBytes: median(samples.map((sample) => sample.rssDeltaBytes)),
    medianStatements: median(samples.map((sample) => sample.statements)),
    samples,
  };
}

function seedFixture(database: AppDatabase, value: FixtureOptions) {
  const client = database.$client;
  const project = client.prepare(
    "insert into projects (id, display_name, display_path, normalized_path, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
  );
  const session = client.prepare(
    "insert into sessions (id, project_id, source_path, cwd, title, started_at, last_seen_at, source_deleted) values (?, ?, ?, ?, ?, ?, ?, 0)",
  );
  const agent = client.prepare(
    "insert into session_agents (id, session_id, source_path, thread_source, parent_thread_id, name, role, depth, task_summary, last_seen_at, source_deleted) values (?, ?, ?, ?, null, ?, ?, ?, ?, ?, 0)",
  );
  const usage = client.prepare(
    "insert into usage_events (id, session_id, agent_id, source_hash, timestamp, local_date, model, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens, input_rate, cached_input_rate, output_rate, cost_usd, turn_key, turn_attribution_version, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.25, 0.25, 10, ?, null, 0, ?)",
  );
  const now = Date.UTC(2026, 6, 30, 0, 0, 0);
  client.transaction(() => {
    for (let index = 0; index < value.projects; index += 1) {
      project.run(
        projectId(index),
        `Synthetic project ${index}`,
        projectPath(index),
        projectPath(index),
        now,
        now,
      );
    }
    for (let index = 0; index < value.sessions; index += 1) {
      const timestamp = fixtureTimestamp(index);
      session.run(
        sessionId(index),
        projectId(index % value.projects),
        `/synthetic/${sessionId(index)}.jsonl`,
        projectPath(index % value.projects),
        `Synthetic session ${String(index).padStart(5, "0")}`,
        timestamp,
        now + index,
      );
    }
    for (let index = 0; index < value.agents; index += 1) {
      const sessionIndex = index % value.sessions;
      agent.run(
        agentId(index),
        sessionId(sessionIndex),
        `/synthetic/${sessionId(sessionIndex)}.jsonl`,
        index % 4 === 0 ? "subagent" : "user",
        `Synthetic agent ${index}`,
        index % 4 === 0 ? "worker" : "main",
        index % 4 === 0 ? 1 : 0,
        "Synthetic benchmark task",
        now + index,
      );
    }
    for (let index = 0; index < value.usageEvents; index += 1) {
      const sessionIndex = index % value.sessions;
      const date = `2026-07-${String((index % 30) + 1).padStart(2, "0")}`;
      const input = 500 + (index % 500);
      const cached = index % 250;
      const output = 100 + (index % 200);
      usage.run(
        `usage-${String(index).padStart(7, "0")}`,
        sessionId(sessionIndex),
        agentId(index % value.agents),
        `hash-${String(index).padStart(7, "0")}`,
        `${date}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
        date,
        `model-${(Math.floor(index / value.agents) + index) % 5}`,
        input,
        cached,
        output,
        index % 50,
        input + output,
        ((input - cached) * 1.25 + cached * 0.25 + output * 10) / 1_000_000,
        now + index,
      );
    }
    client
      .prepare(
        "insert into alert_events (id, type, severity, scope_key, period_start, title, message, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "benchmark-alert",
        "usage_spike",
        "warning",
        "global",
        "2026-07-30",
        "Synthetic alert",
        "Synthetic benchmark alert",
        now,
      );
  })();
  return {
    agents: count(client, "session_agents"),
    projects: count(client, "projects"),
    sessions: count(client, "sessions"),
    usageEvents: count(client, "usage_events"),
  };
}

function count(client: AppDatabase["$client"], table: string): number {
  const row = client.prepare(`select count(*) as count from ${table}`).get() as { count: number };
  return Number(row.count);
}

function projectId(index: number) {
  return `project-${String(index).padStart(4, "0")}`;
}

function projectPath(index: number) {
  return `/synthetic/project-${String(index).padStart(4, "0")}`;
}

function sessionId(index: number) {
  return `session-${String(index).padStart(6, "0")}`;
}

function agentId(index: number) {
  return `agent-${String(index).padStart(5, "0")}`;
}

function fixtureTimestamp(index: number) {
  const date = `2026-07-${String((index % 30) + 1).padStart(2, "0")}`;
  return `${date}T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
