import { Hono } from "hono";
import { z } from "zod";

import { getActivity, getDataHealth } from "@/server/activity";
import {
  backfillUnpricedUsage,
  getDashboard,
  getKnownModels,
  getModelRates,
  getSessions,
  upsertModelRate,
} from "@/server/analytics";
import type { AppDatabase } from "@/server/db/client";
import type { SessionImporter } from "@/server/importer";
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
import { currentLocalDate, dateDaysBefore, type RetentionService } from "@/server/retention";
import type {
  ActivityFilters,
  ActivityKind,
  AgentFilters,
  DashboardFilters,
  PricingSimulationRequest,
  SessionFilters,
} from "@/shared/types";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const rateSchema = z.object({
  cachedInputRate: z.coerce.number().finite().nonnegative(),
  inputRate: z.coerce.number().finite().nonnegative(),
  outputRate: z.coerce.number().finite().nonnegative(),
});
const projectSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
});
const budgetSchema = z
  .object({
    enabled: z.boolean(),
    limitUsd: z.number().finite().nonnegative(),
    period: z.enum(["daily", "monthly"]),
    warningThresholds: z
      .array(z.number().finite().positive().max(1_000))
      .min(1)
      .max(10)
      .transform((values) => [...new Set(values)].sort((left, right) => left - right)),
  })
  .refine((value) => !value.enabled || value.limitUsd > 0, {
    message: "limitUsd must be greater than 0 when budget is enabled",
    path: ["limitUsd"],
  });
const pricingSchema = z
  .object({
    agentKind: z.enum(["all", "main", "subagent"]).optional(),
    from: z.string().refine(isIsoDate, "from must be a valid ISO date"),
    model: z.string().trim().min(1).max(160).optional(),
    models: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
    projectId: z.string().trim().min(1).max(160).optional(),
    rates: z
      .array(rateSchema.extend({ model: z.string().trim().min(1).max(160) }))
      .min(1)
      .max(100),
    to: z.string().refine(isIsoDate, "to must be a valid ISO date"),
  })
  .refine((value) => value.from <= value.to, {
    message: "from must be before or equal to to",
    path: ["from"],
  });
const alertActionSchema = z.object({ action: z.enum(["dismiss", "seen"]) });
const activityKinds = new Set<ActivityKind>([
  "abort",
  "compaction",
  "file",
  "mcp",
  "other",
  "patch",
  "shell",
  "task_completed",
  "task_started",
  "turn",
  "web",
]);

export function createApp(
  database: AppDatabase,
  importer: SessionImporter,
  retention: RetentionService,
) {
  const app = new Hono();

  app.get("/api/health", (context) => {
    const status = importer.getStatus();
    const ok = status.error === null;
    return context.json({ isSyncing: status.isSyncing, ok }, ok ? 200 : 503);
  });
  app.get("/api/status", (context) => context.json(importer.getStatus()));
  app.post("/api/sync", async (context) => context.json(await importer.syncAll()));
  app.get("/api/storage/status", async (context) => context.json(await retention.getStatus()));
  app.post("/api/storage/compact", async (context) => context.json(await retention.compact()));
  app.get("/api/activity", (context) => {
    const filters = parseActivityFilters(context.req.query());
    return filters.success
      ? context.json(getActivity(database, filters.data))
      : context.json({ error: filters.error }, 400);
  });
  app.get("/api/data-health", async (context) =>
    context.json(await getDataHealth(database, importer, retention)),
  );

  app.get("/api/dashboard", (context) => {
    const filters = parseFilters(context.req.query());
    return filters.success
      ? context.json(getDashboard(database, filters.data))
      : context.json({ error: filters.error }, 400);
  });
  app.get("/api/sessions", (context) => {
    const filters = parseSessionFilters(context.req.query());
    return filters.success
      ? context.json(getSessions(database, filters.data))
      : context.json({ error: filters.error }, 400);
  });
  app.get("/api/insights", (context) => {
    const filters = parseFilters(context.req.query());
    return filters.success
      ? context.json(getInsights(database, filters.data))
      : context.json({ error: filters.error }, 400);
  });
  app.get("/api/projects", (context) => {
    const filters = parseFilters(context.req.query());
    return filters.success
      ? context.json(getProjects(database, filters.data))
      : context.json({ error: filters.error }, 400);
  });
  app.put("/api/projects/:id", async (context) => {
    const payload = projectSchema.safeParse(await readJson(context.req.raw));
    if (!payload.success) return context.json({ error: payload.error.flatten() }, 400);
    const project = renameProject(database, context.req.param("id"), payload.data.displayName);
    return project ? context.json({ project }) : context.json({ error: "Project not found" }, 404);
  });
  app.get("/api/agents", (context) => {
    const filters = parseAgentFilters(context.req.query());
    return filters.success
      ? context.json(getAgents(database, filters.data))
      : context.json({ error: filters.error }, 400);
  });
  app.get("/api/budgets", (context) => context.json({ budgets: getBudgets(database) }));
  app.put("/api/budgets", async (context) => {
    const payload = budgetSchema.safeParse(await readJson(context.req.raw));
    return payload.success
      ? context.json({ budget: saveBudget(database, payload.data) })
      : context.json({ error: payload.error.flatten() }, 400);
  });
  app.get("/api/alerts", (context) => context.json({ alerts: refreshAlerts(database) }));
  app.patch("/api/alerts/:id", async (context) => {
    const payload = alertActionSchema.safeParse(await readJson(context.req.raw));
    if (!payload.success) return context.json({ error: payload.error.flatten() }, 400);
    const alert = updateAlert(database, context.req.param("id"), payload.data.action);
    return alert ? context.json({ alert }) : context.json({ error: "Alert not found" }, 404);
  });
  app.post("/api/pricing/simulate", async (context) => {
    const payload = pricingSchema.safeParse(await readJson(context.req.raw));
    if (!payload.success) return context.json({ error: payload.error.flatten() }, 400);
    const request: PricingSimulationRequest = {
      from: payload.data.from,
      rates: payload.data.rates,
      to: payload.data.to,
    };
    if (payload.data.agentKind) request.agentKind = payload.data.agentKind;
    if (payload.data.model) request.model = payload.data.model;
    if (payload.data.models) request.models = payload.data.models;
    if (payload.data.projectId) request.projectId = payload.data.projectId;
    return context.json(simulatePricing(database, request));
  });
  app.get("/api/export", (context) => {
    const query = context.req.query();
    const filters = parseExportFilters(query);
    if (!filters.success) return context.json({ error: filters.error }, 400);
    const dataset = query["dataset"];
    const format = query["format"] ?? "csv";
    if (!dataset || !["agents", "models", "projects", "sessions"].includes(dataset)) {
      return context.json({ error: "invalid export dataset" }, 400);
    }
    if (format !== "csv" && format !== "json") {
      return context.json({ error: "format must be csv or json" }, 400);
    }
    const exported = exportDataset(
      database,
      dataset as "agents" | "models" | "projects" | "sessions",
      filters.data,
      format,
    );
    return context.newResponse(exported.body, 200, {
      "Content-Disposition": `attachment; filename="${exported.filename}"`,
      "Content-Type": exported.contentType,
    });
  });
  app.get("/api/models", (context) => context.json({ models: getKnownModels(database) }));
  app.get("/api/rates", (context) => context.json({ rates: getModelRates(database) }));

  app.put("/api/rates/:model", async (context) => {
    const model = context.req.param("model").trim();
    const payload = rateSchema.safeParse(await readJson(context.req.raw));
    if (!model) return context.json({ error: "Model is required" }, 400);
    if (!payload.success) return context.json({ error: payload.error.flatten() }, 400);

    const rate = upsertModelRate(database, { model, ...payload.data });
    importer.clearRateCache();
    return context.json({ backfilled: backfillUnpricedUsage(database, model), rate });
  });

  app.post("/api/rates/:model/backfill", (context) => {
    const model = context.req.param("model").trim();
    if (!model) return context.json({ error: "Model is required" }, 400);
    return context.json({ updated: backfillUnpricedUsage(database, model) });
  });

  // Keep unknown API routes as JSON 404s in production instead of letting the SPA fallback
  // return index.html for a mistyped endpoint.
  app.all("/api/*", (context) => context.json({ error: "API route not found" }, 404));

  app.onError((error, context) => {
    console.error(error);
    return context.json({ error: "Internal server error" }, 500);
  });

  return app;
}

function parseExportFilters(query: Record<string, string | undefined>):
  | {
      data: AgentFilters & SessionFilters;
      success: true;
    }
  | { error: string; success: false } {
  const session = parseSessionFilters(query);
  if (!session.success) return session;
  const agent = parseAgentFilters(query);
  if (!agent.success) return agent;
  return { data: { ...session.data, ...agent.data }, success: true };
}

function parseAgentFilters(
  query: Record<string, string | undefined>,
): { data: AgentFilters; success: true } | { error: string; success: false } {
  const base = parseFilters(query);
  if (!base.success) return base;
  const role = query["role"]?.trim();
  const depthValue = query["depth"];
  const depth = depthValue === undefined ? undefined : Number(depthValue);
  if (role && role.length > 100)
    return { error: "role must be at most 100 characters", success: false };
  if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 0 || depth > 100)) {
    return { error: "depth must be an integer between 0 and 100", success: false };
  }
  const data: AgentFilters = { ...base.data };
  if (role) data.role = role;
  if (depth !== undefined) data.depth = depth;
  return { data, success: true };
}

function parseActivityFilters(
  query: Record<string, string | undefined>,
): { data: ActivityFilters; success: true } | { error: string; success: false } {
  const base = parseFilters(query);
  if (!base.success) return base;
  const sessionId = query["session"]?.trim();
  if (sessionId && sessionId.length > 160) {
    return { error: "session must be at most 160 characters", success: false };
  }
  const rawKinds = (query["kinds"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawKinds.some((kind) => !activityKinds.has(kind as ActivityKind))) {
    return { error: "invalid activity kind", success: false };
  }
  const data: ActivityFilters = { ...base.data };
  if (rawKinds.length > 0) data.kinds = rawKinds as ActivityKind[];
  if (sessionId) data.sessionId = sessionId;
  return { data, success: true };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseFilters(
  query: Record<string, string | undefined>,
): { data: DashboardFilters; success: true } | { error: string; success: false } {
  const to = query["to"] ?? currentLocalDate();
  const from = query["from"] ?? dateDaysBefore(to, 29);
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
    return { error: "from and to must be ISO dates with from <= to", success: false };
  }
  const model = query["model"]?.trim();
  const models = (query["models"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (model && model.length > 160) {
    return { error: "model must be at most 160 characters", success: false };
  }
  if (models.length > 100 || models.some((value) => value.length > 160)) {
    return {
      error: "models must contain at most 100 values of at most 160 characters",
      success: false,
    };
  }
  const agentKind = query["agentKind"];
  if (agentKind && !["all", "main", "subagent"].includes(agentKind)) {
    return { error: "agentKind must be all, main or subagent", success: false };
  }
  const projectId = query["project"]?.trim();
  if (projectId && projectId.length > 160) {
    return { error: "project must be at most 160 characters", success: false };
  }
  const data: DashboardFilters = { from, to };
  if (agentKind) data.agentKind = agentKind as NonNullable<DashboardFilters["agentKind"]>;
  if (model) data.model = model;
  if (models.length > 0) data.models = [...new Set(models)];
  if (projectId) data.projectId = projectId;
  return { data, success: true };
}

function parseSessionFilters(
  query: Record<string, string | undefined>,
): { data: SessionFilters; success: true } | { error: string; success: false } {
  const base = parseFilters(query);
  if (!base.success) return base;
  const page = positiveInteger(query["page"] ?? "1");
  const pageSize = positiveInteger(query["pageSize"] ?? "25");
  if (!page || !pageSize || pageSize > 100) {
    return {
      error: "page must be positive and pageSize must be between 1 and 100",
      success: false,
    };
  }
  const sortValue = query["sort"] ?? "lastActivity";
  const orderValue = query["order"] ?? "desc";
  if (!["cost", "lastActivity", "tokens"].includes(sortValue))
    return { error: "invalid session sort", success: false };
  if (!["asc", "desc"].includes(orderValue))
    return { error: "invalid session order", success: false };
  const sort = sortValue as NonNullable<SessionFilters["sort"]>;
  const order = orderValue as NonNullable<SessionFilters["order"]>;
  const rawHasSubagents = query["hasSubagents"];
  if (rawHasSubagents && rawHasSubagents !== "true" && rawHasSubagents !== "false") {
    return { error: "hasSubagents must be true or false", success: false };
  }
  const search = query["q"]?.trim();
  if (search && search.length > 200)
    return { error: "q must be at most 200 characters", success: false };
  return {
    data: {
      ...base.data,
      ...(rawHasSubagents ? { hasSubagents: rawHasSubagents === "true" } : {}),
      order,
      page,
      pageSize,
      ...(search ? { query: search } : {}),
      sort,
    },
    success: true,
  };
}

function positiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isIsoDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
