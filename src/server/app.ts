import { Hono, type MiddlewareHandler, type TypedResponse } from "hono";
import { streamSSE } from "hono/streaming";
import type { BlankEnv } from "hono/types";
import { z } from "zod";

import { AppEventBus } from "@/server/app-events";
import { AlertMaterializer } from "@/server/alert-materializer";

import {
  getActivity,
  getActivitySummary,
  getActivityTimeline,
  getDataHealth,
  InvalidActivityCursorError,
} from "@/server/activity";
import {
  backfillUnpricedUsage,
  getDashboard,
  getDailyMinuteReport,
  getKnownModels,
  getModelRates,
  getSessionDetail,
  getSessionSummaries,
  getSessions,
  upsertModelRate,
} from "@/server/analytics";
import type { AppDatabase } from "@/server/db/client";
import type { SessionImporter } from "@/server/importer";
import {
  dismissAllAlerts,
  exportDataset,
  exportTurnDataset,
  getAgents,
  getAgentsPage,
  getAgentsSummary,
  getBudgets,
  getInsights,
  getOverview,
  getProjectOptions,
  getProjectAnalytics,
  getProjectsPage,
  getProjectsSummary,
  getProjects,
  projectExists,
  saveBudget,
  simulatePricing,
  updateAlert,
} from "@/server/product-analytics";
import { renameProject } from "@/server/projects";
import { exportReport, previewReport, ReportRequestError } from "@/server/reports";
import { currentLocalDate, dateDaysBefore, type RetentionService } from "@/server/retention";
import {
  createTag,
  deleteTag,
  getTags,
  InvalidTagNameError,
  renameTag,
  replaceProjectTags,
  TagNameConflictError,
} from "@/server/tags";
import {
  compareTurns,
  getTurnDetail,
  getTurnDiagnostics,
  getTurns,
  TurnDiagnosticsLimitError,
} from "@/server/turns";
import type {
  ActivityFilters,
  ActivityKind,
  ActivityQuery,
  ActivityTimelineQuery,
  AppScanEvent,
  AgentPageFilters,
  AgentPageQuery,
  AgentQuery,
  AgentFilters,
  BudgetQuery,
  DashboardFilters,
  DashboardQuery,
  DailyMinuteReportQuery,
  PricingSimulationRequest,
  ProjectPageFilters,
  ProjectPageQuery,
  ReportRequest,
  SessionFilters,
  SessionQuery,
  TurnComparisonQuery,
  TurnDiagnosticsQuery,
  TurnFilters,
  TurnQuery,
  TurnStatus,
  ImportStatus,
} from "@/shared/types";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const rateSchema = z.object({
  cachedInputRate: z.coerce.number().finite().nonnegative(),
  inputRate: z.coerce.number().finite().nonnegative(),
  outputRate: z.coerce.number().finite().nonnegative(),
});
const projectSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
});
const budgetScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({
    kind: z.literal("project"),
    projectId: z.string().trim().min(1).max(160),
  }),
]);
const budgetSchema = z
  .object({
    enabled: z.boolean(),
    limitUsd: z.number().finite().nonnegative(),
    period: z.enum(["daily", "monthly"]),
    scope: budgetScopeSchema.optional(),
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
const tagSchema = z.object({ name: z.string().max(256) });
const projectTagsSchema = z.object({
  tagIds: z
    .array(z.string().uuid())
    .max(50)
    .transform((values) => [...new Set(values)]),
});
const reportFilterFields = {
  agentKind: z.enum(["all", "main", "subagent"]).optional(),
  from: z.string().refine(isIsoDate, "from must be a valid ISO date"),
  model: z.string().trim().min(1).max(160).optional(),
  models: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  projectId: z.string().trim().min(1).max(160).optional(),
  tagIds: z.array(z.string().uuid()).max(50).optional(),
  to: z.string().refine(isIsoDate, "to must be a valid ISO date"),
};
const reportDashboardFiltersSchema = z
  .object(reportFilterFields)
  .refine((value) => value.from <= value.to, {
    message: "from must be before or equal to to",
    path: ["from"],
  });
const reportAgentFiltersSchema = z
  .object({
    ...reportFilterFields,
    depth: z.number().int().min(0).max(100).optional(),
    role: z.string().trim().min(1).max(100).optional(),
  })
  .refine((value) => value.from <= value.to, {
    message: "from must be before or equal to to",
    path: ["from"],
  });
const reportSessionFiltersSchema = z
  .object({
    ...reportFilterFields,
    hasSubagents: z.boolean().optional(),
    query: z.string().trim().min(1).max(200).optional(),
  })
  .refine((value) => value.from <= value.to, {
    message: "from must be before or equal to to",
    path: ["from"],
  });
const reportTurnFiltersSchema = z
  .object({
    ...reportFilterFields,
    agentId: z.string().trim().min(1).max(160).optional(),
    effort: z.string().trim().min(1).max(100).optional(),
    pressure: z.enum(["70", "70-84", "85", "85-94", "95", "95+", "below-70", "unknown"]).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    sessionId: z.string().trim().min(1).max(160).optional(),
    status: z.enum(["aborted", "completed", "unknown"]).optional(),
  })
  .refine((value) => value.from <= value.to, {
    message: "from must be before or equal to to",
    path: ["from"],
  });
const reportSharedFields = {
  acknowledgeSensitive: z.array(z.string().trim().min(1).max(100)).max(30),
  columns: z.array(z.string().trim().min(1).max(100)).max(100),
  format: z.enum(["csv", "json"]),
};
const reportRequestSchema = z.discriminatedUnion("preset", [
  z.object({
    ...reportSharedFields,
    filters: reportDashboardFiltersSchema,
    preset: z.literal("cost-overview"),
  }),
  z.object({
    ...reportSharedFields,
    filters: reportDashboardFiltersSchema,
    preset: z.literal("project-summary"),
  }),
  z.object({
    ...reportSharedFields,
    filters: reportAgentFiltersSchema,
    preset: z.literal("agent-summary"),
  }),
  z.object({
    ...reportSharedFields,
    filters: reportSessionFiltersSchema,
    preset: z.literal("session-summary"),
  }),
  z.object({
    ...reportSharedFields,
    filters: reportTurnFiltersSchema,
    preset: z.literal("turn-summary"),
  }),
]);
const pricingSchema = z
  .object({
    agentKind: z.enum(["all", "main", "subagent"]).optional(),
    from: z.string().refine(isIsoDate, "from must be a valid ISO date"),
    model: z.string().trim().min(1).max(160).optional(),
    models: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
    projectId: z.string().trim().min(1).max(160).optional(),
    tagIds: z
      .array(z.string().uuid())
      .max(50)
      .transform((values) => [...new Set(values)])
      .optional(),
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
  events: AppEventBus = new AppEventBus(),
  alerts: AlertMaterializer = new AlertMaterializer(database),
) {
  const dependencies = { alerts, database, events, importer, retention };
  const app = new Hono();

  app.use("/api/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  });

  app.get("/api/events", (context) => {
    context.header("Content-Type", "text/event-stream");
    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      let lastHeartbeatAt = Date.now();
      let lastScan = "";
      let wake: (() => void) | null = null;
      const pendingRevisions = new Map<number, ReturnType<AppEventBus["getRevision"]>>();
      const unsubscribe = events.subscribe((event) => {
        pendingRevisions.set(event.revision, event);
        wake?.();
      });

      try {
        const initialRevision = events.getRevision();
        await stream.writeSSE({
          data: JSON.stringify(initialRevision),
          event: "revision",
          id: String(initialRevision.revision),
          retry: 5_000,
        });
        for (const revision of pendingRevisions.keys()) {
          if (revision <= initialRevision.revision) pendingRevisions.delete(revision);
        }

        while (!stream.aborted) {
          const revisions = [...pendingRevisions.values()].sort(
            (left, right) => left.revision - right.revision,
          );
          pendingRevisions.clear();
          for (const revision of revisions) {
            await stream.writeSSE({
              data: JSON.stringify(revision),
              event: "revision",
              id: String(revision.revision),
            });
          }

          const scan = privacySafeScanEvent(importer.getStatus());
          const serializedScan = JSON.stringify(scan);
          if (serializedScan !== lastScan) {
            await stream.writeSSE({ data: serializedScan, event: "scan" });
            lastScan = serializedScan;
          }

          if (Date.now() - lastHeartbeatAt >= 15_000) {
            await stream.write(": heartbeat\n\n");
            lastHeartbeatAt = Date.now();
          }

          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1_000);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = null;
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.route("/", createRpcRoutes(dependencies));
  app.get("/api/export", (context) => {
    const query = context.req.query();
    const dataset = query["dataset"];
    const format = query["format"] ?? "csv";
    if (!dataset || !["agents", "models", "projects", "sessions", "turns"].includes(dataset)) {
      return context.json({ error: "invalid export dataset" }, 400);
    }
    const filters = parseExportFilters(query, dataset);
    if (!filters.success) return context.json({ error: filters.error }, 400);
    if (format !== "csv" && format !== "json") {
      return context.json({ error: "format must be csv or json" }, 400);
    }
    const exported =
      dataset === "turns"
        ? exportTurnDataset(database, filters.data, format)
        : exportDataset(
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

  // Keep unknown API routes as JSON 404s in production instead of letting the SPA fallback
  // return index.html for a mistyped endpoint.
  app.all("/api/*", (context) => context.json({ error: "API route not found" }, 404));

  app.onError((error, context) => {
    console.error(error);
    return context.json({ error: "Internal server error" }, 500);
  });

  return app;
}

type AppDependencies = {
  alerts: AlertMaterializer;
  database: AppDatabase;
  events: AppEventBus;
  importer: SessionImporter;
  retention: RetentionService;
};

function createRpcRoutes(dependencies: AppDependencies) {
  return new Hono()
    .route("/api", createSystemRoutes(dependencies))
    .route("/api", createActivityRoutes(dependencies))
    .route("/api", createAnalyticsRoutes(dependencies))
    .route("/api", createTurnRoutes(dependencies))
    .route("/api", createProductRoutes(dependencies));
}

export type AppType = ReturnType<typeof createRpcRoutes>;

function createSystemRoutes({ alerts, database, events, importer, retention }: AppDependencies) {
  const rateBody = jsonValidator(rateSchema);
  return new Hono()
    .get("/health", (context) => {
      const status = importer.getStatus();
      const ok = status.error === null;
      return context.json({ isSyncing: status.isSyncing, ok }, ok ? 200 : 503);
    })
    .get("/status", (context) => context.json(importer.getStatus()))
    .post("/sync", async (context) => context.json(await importer.syncAll()))
    .post("/sync/deep", (context) =>
      importer.queueDeepSync()
        ? context.json({ accepted: true as const }, 202)
        : context.json({ error: "Deep verification is already queued or running" }, 409),
    )
    .get("/storage/status", async (context) => context.json(await retention.getStatus()))
    .post("/storage/compact", async (context) => context.json(await retention.compact()))
    .get("/data-health", async (context) =>
      context.json(await getDataHealth(database, importer, retention)),
    )
    .get("/models", (context) => context.json({ models: getKnownModels(database) }))
    .get("/rates", (context) => context.json({ rates: getModelRates(database) }))
    .put("/rates/:model", rateBody, (context) => {
      const model = context.req.param("model").trim();
      if (!model) return context.json({ error: "Model is required" }, 400);
      const payload = context.req.valid("json");
      const rate = upsertModelRate(database, { model, ...payload });
      importer.clearRateCache();
      let backfilled: number;
      try {
        backfilled = backfillUnpricedUsage(database, model);
      } catch (error) {
        events.publish("rate", ["catalog", "rates"]);
        throw error;
      }
      if (backfilled > 0) alerts.invalidate("rate");
      if (backfilled > 0) events.publish("rate");
      else events.publish("rate", ["catalog", "rates"]);
      return context.json({ backfilled, rate });
    })
    .post("/rates/:model/backfill", (context) => {
      const model = context.req.param("model").trim();
      if (!model) return context.json({ error: "Model is required" }, 400);
      const updated = backfillUnpricedUsage(database, model);
      if (updated > 0) {
        alerts.invalidate("rate");
        events.publish("rate");
      }
      return context.json({ updated });
    });
}

function createActivityRoutes({ database }: AppDependencies) {
  const activityQuery = queryValidator<ActivityQuery>()(parseActivityFilters);
  const timelineQuery = queryValidator<ActivityTimelineQuery>()(parseActivityTimelineQuery);
  return new Hono()
    .get("/activity/summary", activityQuery, (context) =>
      context.json(getActivitySummary(database, context.req.valid("query"))),
    )
    .get("/activity/timeline", timelineQuery, (context) => {
      const { cursor, filters, limit } = context.req.valid("query");
      try {
        return context.json(
          getActivityTimeline(database, filters, {
            ...(cursor ? { cursor } : {}),
            limit,
          }),
        );
      } catch (error) {
        if (error instanceof InvalidActivityCursorError) {
          return context.json({ error: error.message }, 400);
        }
        throw error;
      }
    })
    .get("/activity", activityQuery, (context) =>
      context.json(getActivity(database, context.req.valid("query"))),
    );
}

function createAnalyticsRoutes({ database, events }: AppDependencies) {
  const dashboardQuery = queryValidator<DashboardQuery>()(parseFilters);
  const dailyMinuteReportQuery = queryValidator<DailyMinuteReportQuery>()(
    parseDailyMinuteReportFilters,
  );
  const sessionQuery = queryValidator<SessionQuery>()(parseSessionFilters);
  const agentQuery = queryValidator<AgentQuery>()(parseAgentFilters);
  const agentPageQuery = queryValidator<AgentPageQuery>()(parseAgentPageFilters);
  const projectPageQuery = queryValidator<ProjectPageQuery>()(parseProjectPageFilters);
  const projectBody = jsonValidator(projectSchema);
  return new Hono()
    .get("/dashboard/minutes", dailyMinuteReportQuery, (context) =>
      context.json(getDailyMinuteReport(database, context.req.valid("query"))),
    )
    .get("/dashboard", dashboardQuery, (context) =>
      context.json(getDashboard(database, context.req.valid("query"))),
    )
    .get("/sessions", sessionQuery, (context) =>
      context.json(getSessions(database, context.req.valid("query"))),
    )
    .get("/sessions/summary", sessionQuery, (context) =>
      context.json(getSessionSummaries(database, context.req.valid("query"))),
    )
    .get("/sessions/:sessionId", dashboardQuery, (context) => {
      const sessionId = context.req.param("sessionId").trim();
      if (!sessionId || sessionId.length > 160) {
        return context.json({ error: "invalid session id" }, 400);
      }
      const session = getSessionDetail(database, sessionId, context.req.valid("query"));
      return session ? context.json(session) : context.json({ error: "Session not found" }, 404);
    })
    .get("/insights", dashboardQuery, (context) =>
      context.json(getInsights(database, context.req.valid("query"))),
    )
    .get("/overview", dashboardQuery, (context) =>
      context.json(getOverview(database, context.req.valid("query"))),
    )
    .get("/projects", dashboardQuery, (context) =>
      context.json(getProjects(database, context.req.valid("query"))),
    )
    .get("/projects/summary", dashboardQuery, (context) =>
      context.json(getProjectsSummary(database, context.req.valid("query"))),
    )
    .get("/projects/page", projectPageQuery, (context) =>
      context.json(getProjectsPage(database, context.req.valid("query"))),
    )
    .get("/projects/options", dashboardQuery, (context) =>
      context.json(getProjectOptions(database, context.req.valid("query"))),
    )
    .get("/projects/:id/analytics", dashboardQuery, (context) => {
      const id = context.req.param("id").trim();
      if (!id || id.length > 160) return context.json({ error: "invalid project id" }, 400);
      const result = getProjectAnalytics(database, id, context.req.valid("query"));
      return result
        ? context.json(result)
        : context.json({ error: "Project not found in the selected range" }, 404);
    })
    .put("/projects/:id", projectBody, (context) => {
      const project = renameProject(
        database,
        context.req.param("id"),
        context.req.valid("json").displayName,
      );
      if (project) events.publish("project", ["catalog", "projects"]);
      return project
        ? context.json({ project })
        : context.json({ error: "Project not found" }, 404);
    })
    .get("/agents", agentQuery, (context) =>
      context.json(getAgents(database, context.req.valid("query"))),
    )
    .get("/agents/summary", agentQuery, (context) =>
      context.json(getAgentsSummary(database, context.req.valid("query"))),
    )
    .get("/agents/page", agentPageQuery, (context) =>
      context.json(getAgentsPage(database, context.req.valid("query"))),
    );
}

function createTurnRoutes({ database, importer }: AppDependencies) {
  const turnQuery = queryValidator<TurnQuery>()(parseTurnFilters);
  const diagnosticsQuery = queryValidator<TurnDiagnosticsQuery>()(parseTurnDiagnosticFilters);
  const comparisonQuery = queryValidator<TurnComparisonQuery>()(parseTurnComparisonQuery);
  return new Hono()
    .get("/turns", turnQuery, (context) => {
      const status = importer.getStatus();
      return context.json(
        getTurns(database, context.req.valid("query"), status.turnBackfill, status.isSyncing),
      );
    })
    .get("/turns/diagnostics", diagnosticsQuery, (context) => {
      try {
        return context.json(
          getTurnDiagnostics(
            database,
            context.req.valid("query"),
            importer.getStatus().turnBackfill,
          ),
        );
      } catch (error) {
        if (error instanceof TurnDiagnosticsLimitError) {
          return context.json({ error: error.message }, 422);
        }
        throw error;
      }
    })
    .get("/turns/compare", comparisonQuery, (context) =>
      context.json(compareTurns(database, context.req.valid("query").ids)),
    )
    .get("/turns/:turnKey", (context) => {
      const turnKey = context.req.param("turnKey");
      if (!/^[a-f0-9]{64}$/.test(turnKey)) {
        return context.json({ error: "invalid turn key" }, 400);
      }
      const detail = getTurnDetail(database, turnKey);
      return detail ? context.json(detail) : context.json({ error: "Turn not found" }, 404);
    });
}

function createProductRoutes({ alerts, database, events, importer }: AppDependencies) {
  const budgetBody = jsonValidator(budgetSchema);
  const budgetQuery = queryValidator<BudgetQuery>()(parseBudgetQuery);
  const alertBody = jsonValidator(alertActionSchema);
  const pricingBody = jsonValidator(pricingSchema);
  const projectTagsBody = jsonValidator(projectTagsSchema);
  const reportBody = jsonValidator(reportRequestSchema);
  const tagBody = jsonValidator(tagSchema);
  return new Hono()
    .get("/budgets", budgetQuery, (context) => {
      const projectId = context.req.valid("query").project;
      if (projectId && !projectExists(database, projectId)) {
        return context.json({ error: "Project not found" }, 404);
      }
      return context.json({ budgets: getBudgets(database, projectId) });
    })
    .put("/budgets", budgetBody, (context) => {
      const budget = saveBudget(database, context.req.valid("json"));
      if (!budget) return context.json({ error: "Project not found" }, 404);
      alerts.invalidate("budget");
      events.publish("budget");
      return context.json({ budget });
    })
    .get("/tags", (context) => context.json(getTags(database)))
    .post("/tags", tagBody, (context) => {
      try {
        const tag = createTag(database, context.req.valid("json").name);
        events.publish("project");
        return context.json({ tag }, 201);
      } catch (error) {
        if (error instanceof InvalidTagNameError) {
          return context.json({ error: error.message }, 400);
        }
        if (error instanceof TagNameConflictError) {
          return context.json({ error: error.message }, 409);
        }
        throw error;
      }
    })
    .put("/tags/:id", tagBody, (context) => {
      try {
        const tag = renameTag(database, context.req.param("id"), context.req.valid("json").name);
        if (!tag) return context.json({ error: "Tag not found" }, 404);
        events.publish("project");
        return context.json({ tag });
      } catch (error) {
        if (error instanceof InvalidTagNameError) {
          return context.json({ error: error.message }, 400);
        }
        if (error instanceof TagNameConflictError) {
          return context.json({ error: error.message }, 409);
        }
        throw error;
      }
    })
    .delete("/tags/:id", (context) => {
      const deleted = deleteTag(database, context.req.param("id"));
      if (!deleted) return context.json({ error: "Tag not found" }, 404);
      events.publish("project");
      return context.json({ deleted: true as const });
    })
    .put("/projects/:id/tags", projectTagsBody, (context) => {
      const result = replaceProjectTags(
        database,
        context.req.param("id"),
        context.req.valid("json").tagIds,
      );
      if (result.status === "project-not-found") {
        return context.json({ error: "Project not found" }, 404);
      }
      if (result.status === "tag-not-found") {
        return context.json({ error: "Tag not found" }, 404);
      }
      events.publish("project");
      return context.json({ tags: result.tags });
    })
    .post("/reports/preview", reportBody, (context) => {
      try {
        const request = normalizeReportRequest(context.req.valid("json"));
        return context.json(previewReport(database, request, importer.getStatus().turnBackfill));
      } catch (error) {
        if (error instanceof ReportRequestError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    })
    .post("/reports/export", reportBody, (context) => {
      try {
        const request = normalizeReportRequest(context.req.valid("json"));
        const report = exportReport(database, request, importer.getStatus().turnBackfill);
        return context.newResponse(report.body, 200, {
          "Content-Disposition": `attachment; filename="${report.filename}"`,
          "Content-Type": report.contentType,
        });
      } catch (error) {
        if (error instanceof ReportRequestError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    })
    .get("/alerts", (context) => context.json(alerts.getFeed()))
    .delete("/alerts", (context) => {
      const dismissedCount = dismissAllAlerts(database);
      if (dismissedCount > 0) events.publish("budget", ["alerts"]);
      return context.json({ dismissedCount });
    })
    .patch("/alerts/:id", alertBody, (context) => {
      const alert = updateAlert(
        database,
        context.req.param("id"),
        context.req.valid("json").action,
      );
      if (alert) events.publish("budget", ["alerts"]);
      return alert ? context.json({ alert }) : context.json({ error: "Alert not found" }, 404);
    })
    .post("/pricing/simulate", pricingBody, (context) => {
      const payload = context.req.valid("json");
      const request: PricingSimulationRequest = {
        from: payload.from,
        rates: payload.rates,
        to: payload.to,
      };
      if (payload.agentKind) request.agentKind = payload.agentKind;
      if (payload.model) request.model = payload.model;
      if (payload.models) request.models = payload.models;
      if (payload.projectId) request.projectId = payload.projectId;
      if (payload.tagIds) request.tagIds = payload.tagIds;
      return context.json(simulatePricing(database, request));
    });
}

type ParseResult<T> = { data: T; success: true } | { error: string; success: false };

type QueryValidationError = TypedResponse<{ error: string }, 400, "json">;
type JsonValidationDetails = {
  fieldErrors: Record<string, string[]>;
  formErrors: string[];
};

function queryValidator<Input extends object>() {
  return function <Output extends object>(
    parser: (query: Record<string, string | undefined>) => ParseResult<Output>,
  ): MiddlewareHandler<
    BlankEnv,
    string,
    { in: { query: Input }; out: { query: Output } },
    QueryValidationError
  > {
    return async (context, next) => {
      const parsed = parser(context.req.query());
      if (!parsed.success) return context.json({ error: parsed.error }, 400);
      context.req.addValidatedData("query", parsed.data);
      return next();
    };
  };
}

function jsonValidator<Schema extends z.ZodType<object>>(
  schema: Schema,
): MiddlewareHandler<
  BlankEnv,
  string,
  {
    in: { json: z.output<Schema> };
    out: { json: z.output<Schema> };
  },
  TypedResponse<{ error: JsonValidationDetails }, 400, "json">
> {
  return async (context, next) => {
    const parsed = schema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) {
      const flattened = parsed.error.flatten();
      const fieldEntries: [string, string[]][] = [];
      for (const [field, messages] of Object.entries(flattened.fieldErrors)) {
        if (!Array.isArray(messages)) continue;
        const values: unknown[] = messages;
        const normalized = values.filter(
          (message): message is string => typeof message === "string",
        );
        if (normalized.length > 0) fieldEntries.push([field, normalized]);
      }
      const fieldErrors = Object.fromEntries(fieldEntries);
      return context.json({ error: { fieldErrors, formErrors: flattened.formErrors } }, 400);
    }
    context.req.addValidatedData("json", parsed.data);
    return next();
  };
}

function parseBudgetQuery(query: BudgetQuery): ParseResult<BudgetQuery> {
  const project = query.project?.trim();
  if (project && project.length > 160) {
    return { error: "project must be at most 160 characters", success: false };
  }
  return { data: project ? { project } : {}, success: true };
}

function privacySafeScanEvent(status: ImportStatus): AppScanEvent {
  return {
    ...status,
    error: status.error ? "Import failed; check server logs for details" : null,
    turnBackfill: {
      ...status.turnBackfill,
      error: status.turnBackfill.error
        ? "Turn attribution backfill failed; check server logs for details"
        : null,
    },
  };
}

type ActivityTimelineInput = {
  cursor?: string;
  filters: ActivityFilters;
  limit: number;
};

function parseActivityTimelineQuery(
  query: Record<string, string | undefined>,
): ParseResult<ActivityTimelineInput> {
  const filters = parseActivityFilters(query);
  if (!filters.success) return filters;
  const limit = positiveInteger(query["limit"] ?? "200");
  if (!limit || limit > 200) {
    return { error: "limit must be an integer between 1 and 200", success: false };
  }
  const cursor = query["cursor"];
  return {
    data: {
      ...(cursor ? { cursor } : {}),
      filters: filters.data,
      limit,
    },
    success: true,
  };
}

function parseTurnComparisonQuery(
  query: Record<string, string | undefined>,
): ParseResult<{ ids: string[] }> {
  const ids = (query["ids"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  if (unique.length < 2 || unique.length > 4 || unique.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
    return { error: "ids must contain 2 to 4 unique turn keys", success: false };
  }
  return { data: { ids: unique }, success: true };
}

function parseExportFilters(
  query: Record<string, string | undefined>,
  dataset: string,
):
  | {
      data: (AgentFilters & SessionFilters) | TurnFilters;
      success: true;
    }
  | { error: string; success: false } {
  if (dataset === "turns") return parseTurnFilters(query);
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

function parseAgentPageFilters(
  query: Record<string, string | undefined>,
): ParseResult<AgentPageFilters> {
  const base = parseAgentFilters(query);
  if (!base.success) return base;
  const page = positiveInteger(query["page"] ?? "1");
  const pageSize = positiveInteger(query["pageSize"] ?? "50");
  if (!page || !pageSize || pageSize > 100) {
    return {
      error: "page must be positive and pageSize must be between 1 and 100",
      success: false,
    };
  }
  const sortValue = query["sort"] ?? "tokens";
  const orderValue = query["order"] ?? "desc";
  if (!["cache", "cost", "output", "requests", "tokens"].includes(sortValue)) {
    return { error: "invalid agent sort", success: false };
  }
  if (!["asc", "desc"].includes(orderValue)) {
    return { error: "invalid agent order", success: false };
  }
  return {
    data: {
      ...base.data,
      order: orderValue as NonNullable<AgentPageFilters["order"]>,
      page,
      pageSize,
      sort: sortValue as NonNullable<AgentPageFilters["sort"]>,
    },
    success: true,
  };
}

function parseProjectPageFilters(
  query: Record<string, string | undefined>,
): ParseResult<ProjectPageFilters> {
  const base = parseFilters(query);
  if (!base.success) return base;
  const page = positiveInteger(query["page"] ?? "1");
  const pageSize = positiveInteger(query["pageSize"] ?? "50");
  if (!page || !pageSize || pageSize > 100) {
    return {
      error: "page must be positive and pageSize must be between 1 and 100",
      success: false,
    };
  }
  return { data: { ...base.data, page, pageSize }, success: true };
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
  const tagIds = [
    ...new Set(
      (query["tags"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (tagIds.length > 50 || tagIds.some((value) => !uuidPattern.test(value))) {
    return { error: "tags must contain at most 50 UUIDs", success: false };
  }
  const data: DashboardFilters = { from, to };
  if (agentKind) data.agentKind = agentKind as NonNullable<DashboardFilters["agentKind"]>;
  if (model) data.model = model;
  if (models.length > 0) data.models = [...new Set(models)];
  if (projectId) data.projectId = projectId;
  if (tagIds.length > 0) data.tagIds = tagIds;
  return { data, success: true };
}

function parseDailyMinuteReportFilters(
  query: Record<string, string | undefined>,
): ParseResult<DashboardFilters> {
  const date = query["date"];
  if (!date || !isIsoDate(date)) {
    return { error: "date must be a valid ISO date", success: false };
  }
  return parseFilters({ ...query, from: date, to: date });
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

function parseTurnFilters(
  query: Record<string, string | undefined>,
): { data: TurnFilters; success: true } | { error: string; success: false } {
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
  if (!["context", "cost", "duration", "lastActivity", "tokens", "ttft"].includes(sortValue)) {
    return { error: "invalid turn sort", success: false };
  }
  if (!["asc", "desc"].includes(orderValue)) {
    return { error: "invalid turn order", success: false };
  }
  const status = query["status"]?.trim();
  if (status && !["aborted", "completed", "unknown"].includes(status)) {
    return { error: "invalid turn status", success: false };
  }
  const pressure = query["pressure"]?.trim();
  if (
    pressure &&
    !["70", "70-84", "85", "85-94", "95", "95+", "below-70", "unknown"].includes(pressure)
  ) {
    return { error: "invalid context pressure filter", success: false };
  }
  const queryValue = query["q"]?.trim();
  const effort = query["effort"]?.trim();
  const sessionId = query["session"]?.trim();
  const agentId = query["agent"]?.trim();
  for (const [name, value, limit] of [
    ["q", queryValue, 200],
    ["effort", effort, 100],
    ["session", sessionId, 160],
    ["agent", agentId, 160],
  ] as const) {
    if (value && value.length > limit) {
      return { error: `${name} must be at most ${limit} characters`, success: false };
    }
  }
  const data: TurnFilters = {
    ...base.data,
    order: orderValue as NonNullable<TurnFilters["order"]>,
    page,
    pageSize,
    sort: sortValue as NonNullable<TurnFilters["sort"]>,
  };
  if (status) data.status = status as TurnStatus;
  if (pressure) data.pressure = pressure as NonNullable<TurnFilters["pressure"]>;
  if (queryValue) data.query = queryValue;
  if (effort) data.effort = effort;
  if (sessionId) data.sessionId = sessionId;
  if (agentId) data.agentId = agentId;
  return { data, success: true };
}

function parseTurnDiagnosticFilters(
  query: Record<string, string | undefined>,
): { data: TurnFilters; success: true } | { error: string; success: false } {
  if (
    query["order"] !== undefined ||
    query["page"] !== undefined ||
    query["pageSize"] !== undefined ||
    query["sort"] !== undefined
  ) {
    return { error: "turn diagnostics does not accept pagination or sort", success: false };
  }
  const parsed = parseTurnFilters(query);
  if (!parsed.success) return parsed;
  const data = { ...parsed.data };
  delete data.order;
  delete data.page;
  delete data.pageSize;
  delete data.sort;
  return { data, success: true };
}

type ValidatedReportRequest = z.output<typeof reportRequestSchema>;

function normalizeReportRequest(value: ValidatedReportRequest): ReportRequest {
  const shared = {
    acknowledgeSensitive: value.acknowledgeSensitive,
    format: value.format,
  };
  switch (value.preset) {
    case "agent-summary": {
      const filters: AgentFilters = normalizeReportDashboardFilters(value.filters);
      if (value.filters.depth !== undefined) filters.depth = value.filters.depth;
      if (value.filters.role !== undefined) filters.role = value.filters.role;
      return { ...shared, columns: value.columns, filters, preset: value.preset };
    }
    case "cost-overview":
      return {
        ...shared,
        columns: value.columns,
        filters: normalizeReportDashboardFilters(value.filters),
        preset: value.preset,
      };
    case "project-summary":
      return {
        ...shared,
        columns: value.columns,
        filters: normalizeReportDashboardFilters(value.filters),
        preset: value.preset,
      };
    case "session-summary": {
      const filters: Omit<SessionFilters, "order" | "page" | "pageSize" | "sort"> =
        normalizeReportDashboardFilters(value.filters);
      if (value.filters.hasSubagents !== undefined) {
        filters.hasSubagents = value.filters.hasSubagents;
      }
      if (value.filters.query !== undefined) filters.query = value.filters.query;
      return { ...shared, columns: value.columns, filters, preset: value.preset };
    }
    case "turn-summary": {
      const filters: Omit<TurnFilters, "order" | "page" | "pageSize" | "sort"> =
        normalizeReportDashboardFilters(value.filters);
      if (value.filters.agentId !== undefined) filters.agentId = value.filters.agentId;
      if (value.filters.effort !== undefined) filters.effort = value.filters.effort;
      if (value.filters.pressure !== undefined) filters.pressure = value.filters.pressure;
      if (value.filters.query !== undefined) filters.query = value.filters.query;
      if (value.filters.sessionId !== undefined) filters.sessionId = value.filters.sessionId;
      if (value.filters.status !== undefined) filters.status = value.filters.status;
      return { ...shared, columns: value.columns, filters, preset: value.preset };
    }
  }
}

function normalizeReportDashboardFilters(
  value: z.output<typeof reportDashboardFiltersSchema>,
): DashboardFilters {
  const filters: DashboardFilters = { from: value.from, to: value.to };
  if (value.agentKind !== undefined) filters.agentKind = value.agentKind;
  if (value.model !== undefined) filters.model = value.model;
  if (value.models !== undefined) filters.models = value.models;
  if (value.projectId !== undefined) filters.projectId = value.projectId;
  if (value.tagIds !== undefined) filters.tagIds = value.tagIds;
  return filters;
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
