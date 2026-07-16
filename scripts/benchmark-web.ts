import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { chromium, type Page, type Request, type Response } from "@playwright/test";

import { createDatabase, migrateDatabase } from "@/server/db/client";
import type {
  ActivityTimelineResponse,
  AgentsPageResponse,
  AgentsSummaryResponse,
  ProjectOptionsResponse,
  ProjectsPageResponse,
  ProjectsSummaryResponse,
  SessionSummariesResponse,
} from "@/shared/types";

type Options = {
  activityEvents: number;
  agents: number;
  coldContexts: number;
  projects: number;
  sessions: number;
  usageEvents: number;
  warmIterations: number;
};

type NetworkRecord = {
  api: boolean;
  bytes: number;
  durationMs: number;
  path: string;
  resourceType: string;
};

type NavigationMeasurement = {
  apiBytes: number;
  apiCount: number;
  apiRequests: { bytes: number; durationMs: number; path: string }[];
  browserHeapBytes: number | null;
  browserHeapDeltaBytes: number | null;
  documentDomNodes: number;
  domNodes: number;
  durationMs: number;
  jsBytes: number;
  jsRequests: number;
  longTaskDurationMs: number;
  longTaskMaxDurationMs: number;
  longTasks: number;
  routeDomNodes: number;
  route: string;
};

const options = parseOptions(process.argv.slice(2));
const root = await mkdtemp(join(tmpdir(), "codex-usage-web-benchmark-"));
const sessionsDirectory = join(root, "sessions");
const databasePath = join(root, "usage.db");
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const outputDirectory = join(process.cwd(), ".local", "benchmarks");
let server: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

try {
  await mkdir(sessionsDirectory, { recursive: true });
  const exactCounts = seedFixture(databasePath, options);
  server = startServer(databasePath, sessionsDirectory, port);
  await waitForServer(`${baseUrl}/api/status`);
  const nodeMemoryBefore = await readServerMemory(server);
  browser = await chromium.launch({ headless: true });

  const coldRoutes = ["/", "/sessions", "/activity"];
  const cold: NavigationMeasurement[] = [];
  let warmContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  let warmPage: Page | null = null;
  for (let index = 0; index < options.coldContexts; index += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installLongTaskObserver(page);
    cold.push(await measureNavigation(page, baseUrl, coldRoutes[index % coldRoutes.length]!, true));
    if (index === options.coldContexts - 1) {
      warmContext = context;
      warmPage = page;
    } else {
      await context.close();
    }
  }

  if (!warmContext || !warmPage) throw new Error("Benchmark did not create a warm browser context");
  const warmRoutes = ["/sessions", "/activity", "/agents", "/projects", "/"];
  const warm: NavigationMeasurement[] = [];
  for (let index = 0; index < options.warmIterations; index += 1) {
    const route = warmRoutes[index % warmRoutes.length]!;
    warm.push(await measureNavigation(warmPage, baseUrl, route, false));
    const preset = index % 2 === 0 ? "7 ngày" : "30 ngày";
    const button = warmPage.getByRole("button", { exact: true, name: preset }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.evaluate((element) => (element as HTMLButtonElement).click());
      await waitForQueryIdle(warmPage);
    }
  }
  await warmContext.close();

  const apiProbes = {
    overview30Days: await measureHttpResponse(
      `${baseUrl}/api/overview?from=2026-06-17&to=2026-07-16`,
    ),
    overview7Days: await measureHttpResponse(
      `${baseUrl}/api/overview?from=2026-07-10&to=2026-07-16`,
    ),
    sessions7Days: await measureHttpResponse(
      `${baseUrl}/api/sessions/summary?from=2026-07-10&to=2026-07-16&order=desc&page=1&pageSize=20&sort=lastActivity`,
    ),
  };
  const payloads = await measurePayloads(baseUrl);
  assertPayloadBudget("project options", payloads.projectOptions.bytes, 15_000);
  assertPayloadBudget("activity timeline", payloads.activityTimeline.bytes, 150_000);
  assertPayloadBudget("session summaries", payloads.sessionSummaries.bytes, 40_000);
  assertPayloadBudget("agent summary and first page", payloads.agents.bytes, 75_000);
  assertPayloadBudget("project summary and first page", payloads.projects.bytes, 75_000);
  assertPayloadBudget("project detail", payloads.projectDetail.bytes, 30_000);
  assertItemCount(
    "project options",
    payloads.projectOptions.items,
    Math.min(options.projects, options.sessions, options.usageEvents),
  );
  assertItemCount(
    "activity timeline",
    payloads.activityTimeline.items,
    Math.min(200, options.activityEvents),
  );
  assertItemCount(
    "session summaries",
    payloads.sessionSummaries.items,
    Math.min(20, options.sessions),
  );
  assertItemCount("agent page", payloads.agents.items, Math.min(50, options.agents));
  assertItemCount("agent total", payloads.agents.total, options.agents);
  assertItemCount("project page", payloads.projects.items, Math.min(50, options.projects));
  assertItemCount("project total", payloads.projects.total, options.projects);
  for (const measurement of warm.filter((value) => value.route === "/agents")) {
    assertDomBudget("agents route", measurement.routeDomNodes, 1_500);
    if (measurement.longTaskMaxDurationMs >= 50) {
      throw new Error(
        `agents route long task ${measurement.longTaskMaxDurationMs} ms exceeds 50 ms`,
      );
    }
  }
  for (const measurement of warm.filter((value) => value.route === "/projects")) {
    assertDomBudget("projects route", measurement.routeDomNodes, 2_000);
  }
  const nodeMemoryAfter = await readServerMemory(server);
  const result = {
    apiProbes,
    cold,
    configuration: options,
    exactCounts,
    measurementNote:
      "Synthetic fixture only. Durations and memory have no CI wall-clock threshold; compare medians on the same machine.",
    medians: {
      coldDurationMs: median(cold.map((value) => value.durationMs)),
      coldJsBytes: median(cold.map((value) => value.jsBytes)),
      warmDurationMs: median(warm.map((value) => value.durationMs)),
      warmJsBytes: median(warm.map((value) => value.jsBytes)),
    },
    nodeMemory: { after: nodeMemoryAfter, before: nodeMemoryBefore },
    payloads,
    warm,
  };
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = join(
    outputDirectory,
    `web-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, ...result }, null, 2)}\n`);
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(root, { force: true, recursive: true });
}

function seedFixture(databasePath: string, value: Options) {
  const database = createDatabase(databasePath);
  migrateDatabase(database);
  const client = database.$client;
  const project = client.prepare(
    `insert into projects
      (id, display_name, display_path, normalized_path, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
  );
  const session = client.prepare(
    `insert into sessions
      (id, project_id, source_path, cwd, title, started_at, last_seen_at, source_deleted)
     values (?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const agent = client.prepare(
    `insert into session_agents
      (id, session_id, source_path, thread_source, parent_thread_id, name, role, depth,
       task_summary, last_seen_at, source_deleted)
     values (?, ?, ?, ?, null, ?, ?, ?, ?, ?, 0)`,
  );
  const usage = client.prepare(
    `insert into usage_events
      (id, session_id, agent_id, source_hash, timestamp, local_date, model, input_tokens,
       cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens, input_rate,
       cached_input_rate, output_rate, cost_usd, turn_key, turn_attribution_version, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.25, 0.25, 10, ?, null, 0, ?)`,
  );
  const activity = client.prepare(
    `insert into activity_events
      (id, session_id, agent_id, timestamp, local_date, kind, agent_kind, project_id,
       turn_key, turn_attribution_version, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?)`,
  );
  const seededAt = Date.UTC(2026, 6, 16, 0, 0, 0);
  client.transaction(() => {
    for (let index = 0; index < value.projects; index += 1) {
      const id = projectId(index);
      project.run(
        id,
        `Synthetic project ${String(index).padStart(3, "0")}`,
        projectPath(index),
        projectPath(index),
        seededAt,
        seededAt,
      );
    }
    for (let index = 0; index < value.sessions; index += 1) {
      const id = sessionId(index);
      const project = projectId(index % value.projects);
      const timestamp = fixtureTimestamp(index);
      session.run(
        id,
        project,
        `/synthetic/${id}.jsonl`,
        projectPath(index % value.projects),
        `Synthetic session ${String(index).padStart(5, "0")}`,
        timestamp,
        seededAt + index,
      );
    }
    for (let index = 0; index < value.agents; index += 1) {
      const sessionIndex = index % value.sessions;
      agent.run(
        agentId(index),
        sessionId(sessionIndex),
        `/synthetic/${sessionId(sessionIndex)}.jsonl`,
        index % 4 === 0 ? "subagent" : "user",
        `Synthetic agent ${String(index).padStart(4, "0")}`,
        index % 4 === 0 ? "worker" : "main",
        index % 4 === 0 ? 1 : 0,
        "Synthetic benchmark task",
        seededAt + index,
      );
    }
    for (let index = 0; index < value.usageEvents; index += 1) {
      const sessionIndex = index % value.sessions;
      const dateIndex = index % 30;
      const localDate = `2026-07-${String(dateIndex + 1).padStart(2, "0")}`;
      const timestamp = `${localDate}T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
      const input = 500 + (index % 500);
      const cached = index % 250;
      const output = 100 + (index % 200);
      usage.run(
        `usage-${String(index).padStart(7, "0")}`,
        sessionId(sessionIndex),
        agentId(index % value.agents),
        `hash-${String(index).padStart(7, "0")}`,
        timestamp,
        localDate,
        `model-${(Math.floor(index / value.agents) + index) % 5}`,
        input,
        cached,
        output,
        index % 50,
        input + output,
        ((input - cached) * 1.25 + cached * 0.25 + output * 10) / 1_000_000,
        seededAt + index,
      );
    }
    const kinds = ["turn", "shell", "patch", "file", "web"];
    for (let index = 0; index < value.activityEvents; index += 1) {
      const sessionIndex = index % value.sessions;
      const dateIndex = index % 30;
      const localDate = `2026-07-${String(dateIndex + 1).padStart(2, "0")}`;
      activity.run(
        `activity-${String(index).padStart(7, "0")}`,
        sessionId(sessionIndex),
        agentId(index % value.agents),
        `${localDate}T${String(index % 24).padStart(2, "0")}:30:00.000Z`,
        localDate,
        kinds[index % kinds.length],
        (index % value.agents) % 4 === 0 ? "subagent" : "main",
        projectId(sessionIndex % value.projects),
        seededAt + index,
      );
    }
  })();
  const exactCounts = {
    activityEvents: count(client, "activity_events"),
    agents: count(client, "session_agents"),
    projects: count(client, "projects"),
    sessions: count(client, "sessions"),
    usageEvents: count(client, "usage_events"),
  };
  database.$client.close();
  for (const [key, expected] of Object.entries({
    activityEvents: value.activityEvents,
    agents: value.agents,
    projects: value.projects,
    sessions: value.sessions,
    usageEvents: value.usageEvents,
  })) {
    if (exactCounts[key as keyof typeof exactCounts] !== expected) {
      throw new Error(`Fixture ${key} count is not exact`);
    }
  }
  return exactCounts;
}

function startServer(databasePath: string, sessionsDirectory: string, port: number): ChildProcess {
  const child = fork(join(process.cwd(), "build-server", "index.js"), [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_SESSIONS_DIR: sessionsDirectory,
      CODEX_USAGE_DB: databasePath,
      CODEX_USAGE_SCAN_INTERVAL_MINUTES: "1440",
      NODE_ENV: "production",
      PORT: String(port),
    },
    execArgv: ["--max-old-space-size=64", "--max-semi-space-size=4"],
    silent: true,
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  return child;
}

async function measureNavigation(
  page: Page,
  baseUrl: string,
  route: string,
  cold: boolean,
): Promise<NavigationMeasurement> {
  await resetLongTasks(page);
  const browserHeapBefore = await readBrowserHeap(page);
  const records: Promise<NetworkRecord>[] = [];
  const requestStartedAt = new Map<Request, number>();
  const requestListener = (request: Request) => requestStartedAt.set(request, performance.now());
  const responseListener = (response: Response) =>
    records.push(
      readNetworkRecord(
        response,
        baseUrl,
        requestStartedAt.get(response.request()) ?? performance.now(),
      ),
    );
  page.on("request", requestListener);
  page.on("response", responseListener);
  const startedAt = performance.now();
  if (cold) {
    await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded" });
  } else {
    const link = page
      .getByRole("navigation", { name: "Điều hướng chính" })
      .getByRole("link", { exact: true, name: navigationLabel(route) });
    await link.hover();
    await link.focus();
    await link.click();
    await page.waitForFunction((pathname) => window.location.pathname === pathname, route, {
      timeout: 30_000,
    });
  }
  await waitForRouteReady(page, route);
  await waitForQueryIdle(page);
  await waitForRender(page);
  const durationMs = round(performance.now() - startedAt);
  page.off("request", requestListener);
  page.off("response", responseListener);
  const network = await Promise.all(records);
  const browser = await page.evaluate(() => {
    const longTasks = Reflect.get(window, "__codexUsageLongTasks") as number[] | undefined;
    return {
      documentDomNodes: document.getElementsByTagName("*").length,
      longTaskDurationMs: (longTasks ?? []).reduce((total, value) => total + value, 0),
      longTaskMaxDurationMs: Math.max(0, ...(longTasks ?? [])),
      longTasks: longTasks?.length ?? 0,
      routeDomNodes: document.querySelector("main")?.getElementsByTagName("*").length ?? 0,
    };
  });
  const browserHeapBytes = await readBrowserHeap(page);
  const api = network.filter((record) => record.api);
  const scripts = network.filter((record) => record.resourceType === "script");
  return {
    apiBytes: sum(api.map((record) => record.bytes)),
    apiCount: api.length,
    apiRequests: api.map(({ bytes, durationMs, path }) => ({ bytes, durationMs, path })),
    ...browser,
    browserHeapBytes,
    browserHeapDeltaBytes:
      browserHeapBytes === null || browserHeapBefore === null
        ? null
        : browserHeapBytes - browserHeapBefore,
    domNodes: browser.documentDomNodes,
    durationMs,
    jsBytes: sum(scripts.map((record) => record.bytes)),
    jsRequests: scripts.length,
    longTaskDurationMs: round(browser.longTaskDurationMs),
    route,
  };
}

async function readNetworkRecord(
  response: Response,
  baseUrl: string,
  startedAt: number,
): Promise<NetworkRecord> {
  const url = new URL(response.url());
  const api = url.origin === baseUrl && url.pathname.startsWith("/api/");
  const resourceType = response.request().resourceType();
  if (url.pathname === "/api/events") {
    return { api, bytes: 0, durationMs: 0, path: url.pathname, resourceType };
  }
  await response.finished().catch(() => null);
  const body = await response.body().catch(() => Buffer.alloc(0));
  return {
    api,
    bytes: body.byteLength,
    durationMs: round(Math.max(0, performance.now() - startedAt)),
    path: `${url.pathname}${url.search}`,
    resourceType,
  };
}

async function readBrowserHeap(page: Page): Promise<number | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const usage = (await session.send("Runtime.getHeapUsage")) as unknown;
    if (typeof usage !== "object" || usage === null || !("usedSize" in usage)) return null;
    return typeof usage.usedSize === "number" ? usage.usedSize : null;
  } finally {
    await session.detach();
  }
}

async function installLongTaskObserver(page: Page) {
  await page.addInitScript(() => {
    Reflect.set(window, "__codexUsageLongTasks", []);
    if (typeof PerformanceObserver === "undefined") return;
    try {
      new PerformanceObserver((list) => {
        const values = Reflect.get(window, "__codexUsageLongTasks") as number[];
        values.push(...list.getEntries().map((entry) => entry.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // Unsupported browsers report no long tasks.
    }
  });
}

async function resetLongTasks(page: Page) {
  await page.evaluate(() => Reflect.set(window, "__codexUsageLongTasks", []));
}

async function waitForRouteReady(page: Page, route: string) {
  await page
    .getByRole("heading", { exact: true, level: 1, name: routeHeading(route) })
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForQueryIdle(page: Page) {
  await page.waitForFunction(
    () => document.querySelector(".query-progress")?.classList.contains("opacity-0") !== false,
    undefined,
    { timeout: 30_000 },
  );
}

async function waitForRender(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function measurePayloads(baseUrl: string) {
  const range = "from=2026-07-01&to=2026-07-30";
  const projectOptions = await responsePayload<ProjectOptionsResponse>(
    `${baseUrl}/api/projects/options?${range}`,
  );
  const activityTimeline = await responsePayload<ActivityTimelineResponse>(
    `${baseUrl}/api/activity/timeline?${range}&limit=200`,
  );
  const sessionSummaries = await responsePayload<SessionSummariesResponse>(
    `${baseUrl}/api/sessions/summary?${range}&page=1&pageSize=20`,
  );
  const agentSummary = await responsePayload<AgentsSummaryResponse>(
    `${baseUrl}/api/agents/summary?${range}`,
  );
  const agentPage = await responsePayload<AgentsPageResponse>(
    `${baseUrl}/api/agents/page?${range}&page=1&pageSize=50&sort=tokens&order=desc`,
  );
  const projectSummary = await responsePayload<ProjectsSummaryResponse>(
    `${baseUrl}/api/projects/summary?${range}`,
  );
  const projectPage = await responsePayload<ProjectsPageResponse>(
    `${baseUrl}/api/projects/page?${range}&page=1&pageSize=50`,
  );
  const firstProject = projectPage.data.projects[0];
  const projectDetail = firstProject
    ? await responsePayload<unknown>(
        `${baseUrl}/api/projects/${encodeURIComponent(firstProject.id)}/analytics?${range}`,
      )
    : { bytes: 0, data: null };
  return {
    agents: {
      bytes: agentSummary.bytes + agentPage.bytes,
      items: agentPage.data.agents.length,
      total: agentSummary.data.totalAgents,
    },
    activityTimeline: {
      bytes: activityTimeline.bytes,
      items: activityTimeline.data.items.length,
    },
    projectOptions: { bytes: projectOptions.bytes, items: projectOptions.data.projects.length },
    projectDetail: { bytes: projectDetail.bytes, items: firstProject ? 1 : 0 },
    projects: {
      bytes: projectSummary.bytes + projectPage.bytes,
      items: projectPage.data.projects.length,
      total: projectPage.data.total,
    },
    sessionSummaries: {
      bytes: sessionSummaries.bytes,
      items: sessionSummaries.data.sessions.length,
    },
  };
}

async function responsePayload<T>(url: string): Promise<{ bytes: number; data: T }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const contents = await response.text();
  return { bytes: Buffer.byteLength(contents), data: JSON.parse(contents) as T };
}

async function measureHttpResponse(url: string) {
  const startedAt = performance.now();
  const response = await fetch(url);
  const contents = await response.arrayBuffer();
  return {
    bytes: contents.byteLength,
    durationMs: round(performance.now() - startedAt),
    status: response.status,
  };
}

function assertPayloadBudget(name: string, actual: number, budget: number) {
  if (actual > budget) throw new Error(`${name} payload ${actual} B exceeds ${budget} B`);
}

function assertItemCount(name: string, actual: number, expected: number) {
  if (actual !== expected)
    throw new Error(`${name} returned ${actual} items; expected ${expected}`);
}

function assertDomBudget(name: string, actual: number, budget: number) {
  if (actual > budget) throw new Error(`${name} DOM ${actual} exceeds ${budget}`);
}

async function readServerMemory(child: ChildProcess) {
  const id = Math.random().toString(36).slice(2);
  return new Promise<NodeJS.MemoryUsage>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out reading server memory")), 5_000);
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        Reflect.get(message, "type") !== "benchmark:memory" ||
        Reflect.get(message, "id") !== id
      ) {
        return;
      }
      clearTimeout(timeout);
      child.off("message", onMessage);
      resolve(Reflect.get(message, "memory") as NodeJS.MemoryUsage);
    };
    child.on("message", onMessage);
    child.send?.({ id, type: "benchmark:memory" });
  });
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production server did not start: ${String(lastError)}`);
}

async function stopServer(child: ChildProcess | null) {
  if (child?.exitCode !== null) return;
  child.send?.("shutdown");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGTERM");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Could not allocate benchmark port");
  return port;
}

function parseOptions(arguments_: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_.at(index);
    const value = arguments_.at(index + 1);
    if (key?.startsWith("--") && value && !value.startsWith("--")) {
      values.set(key.slice(2), value);
      index += 1;
    }
  }
  return {
    activityEvents: positiveInteger(values.get("activity-events"), 50_000),
    agents: positiveInteger(values.get("agents"), 1_000),
    coldContexts: positiveInteger(values.get("cold-contexts"), 3),
    projects: positiveInteger(values.get("projects"), 100),
    sessions: positiveInteger(values.get("sessions"), 5_000),
    usageEvents: positiveInteger(values.get("usage-events"), 50_000),
    warmIterations: positiveInteger(values.get("warm-iterations"), 10),
  };
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`Invalid benchmark count ${value}`);
  return parsed;
}

function count(client: { prepare: (sql: string) => { get: () => unknown } }, table: string) {
  const row = client.prepare(`select count(*) as count from ${table}`).get() as { count: number };
  return Number(row.count);
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round(((sorted.at(middle - 1) ?? 0) + (sorted.at(middle) ?? 0)) / 2)
    : (sorted.at(middle) ?? 0);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function fixtureTimestamp(index: number) {
  const day = (index % 30) + 1;
  return `2026-07-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}

function navigationLabel(route: string) {
  switch (route) {
    case "/":
      return "Tổng quan";
    case "/activity":
      return "Hoạt động";
    case "/agents":
      return "Agent";
    case "/projects":
      return "Dự án";
    case "/sessions":
      return "Phiên";
    default:
      throw new Error(`No benchmark navigation label for ${route}`);
  }
}

function routeHeading(route: string) {
  if (route === "/") return "Tổng quan mức sử dụng";
  return route === "/sessions" ? "Khám phá phiên" : navigationLabel(route);
}

function projectId(index: number) {
  return createHash("sha256").update(projectPath(index)).digest("hex").slice(0, 24);
}

function projectPath(index: number) {
  return `/benchmark/project-${String(index).padStart(3, "0")}`;
}

function sessionId(index: number) {
  return `session-${String(index).padStart(5, "0")}`;
}

function agentId(index: number) {
  return `agent-${String(index).padStart(4, "0")}`;
}
