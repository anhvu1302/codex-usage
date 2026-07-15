import { createHash } from "node:crypto";

import { desc, eq, isNull } from "drizzle-orm";

import { getDashboard, getSessions } from "@/server/analytics";
import type { AppDatabase } from "@/server/db/client";
import { alertEvents, budgetSettings, projects, sessionAgents } from "@/server/db/schema";
import {
  calculateEfficiencyMetrics,
  getInclusiveDayCount,
  getPreviousDateRange,
  isUsageAnomaly,
  projectMonthlyCost,
} from "@/server/insights";
import { currentLocalDate, dateDaysBefore, getSessionCoverage } from "@/server/retention";
import { getTurnPage } from "@/server/turns";
import type {
  AgentFilters,
  AgentUsageSummary,
  AgentsResponse,
  AlertEvent,
  BudgetSetting,
  DashboardFilters,
  DashboardKpis,
  InsightAlert,
  InsightsResponse,
  MetricDelta,
  PricingSimulationRequest,
  PricingSimulationResponse,
  ProjectSummary,
  ProjectsResponse,
  SessionFilters,
  SessionUsage,
  TurnFilters,
} from "@/shared/types";

type ExportFilters = (AgentFilters & SessionFilters) | TurnFilters;
const ALERT_FEED_LIMIT = 100;
const ALERT_MATERIALIZATION_BATCH = 200;

type AgentUsageRow = {
  agentId: string;
  agentKind: "main" | "subagent";
  cachedInputTokens: number;
  costUsd: number;
  firstEventAt: string;
  inputTokens: number;
  lastEventAt: string;
  localDate: string;
  model: string;
  outputTokens: number;
  projectId: string;
  reasoningOutputTokens: number;
  requestCount: number;
  sessionId: string;
  totalTokens: number;
  unpricedUsageCount: number;
};

export function getInsights(
  database: AppDatabase,
  filters: DashboardFilters,
  now = new Date(),
): InsightsResponse {
  const current = getDashboard(database, filters, now);
  const previousRange = getPreviousDateRange(filters);
  const previous = getDashboard(database, { ...filters, ...previousRange }, now);
  const baselineFrom = dateDaysBefore(filters.from, 14);
  const history = getDashboard(database, { ...filters, from: baselineFrom, to: filters.to }, now);
  const anomalies = detectDailyAnomalies(
    history.daily.map((day) => ({
      cost: day.estimatedCostUsd,
      date: day.date,
      tokens: day.totalTokens,
    })),
    filters.from,
    filters.to,
  );
  const baselineSessions = getAllSessions(database, {
    ...filters,
    from: baselineFrom,
    to: dateDaysBefore(filters.from, 1),
  });
  const unusualSession = detectUnusualSession(getAllSessions(database, filters), baselineSessions);

  const today = currentLocalDate(now);
  const monthRange = { from: `${today.slice(0, 7)}-01`, to: today };
  const monthUsage = getDashboard(database, { ...filters, ...monthRange }, now);
  const previousCostByModel = new Map(
    previous.models.map((model) => [model.model, model.estimatedCostUsd]),
  );
  const modelCostMover = current.models
    .map((model) => {
      const previousCostUsd = previousCostByModel.get(model.model) ?? 0;
      return {
        currentCostUsd: model.estimatedCostUsd,
        deltaUsd: model.estimatedCostUsd - previousCostUsd,
        model: model.model,
        previousCostUsd,
      };
    })
    .sort((left, right) => right.deltaUsd - left.deltaUsd)[0];

  return {
    anomalies,
    current: current.kpis,
    deltas: {
      cost: metricDelta(current.kpis.estimatedCostUsd, previous.kpis.estimatedCostUsd),
      requests: metricDelta(current.kpis.requestCount, previous.kpis.requestCount),
      tokens: metricDelta(current.kpis.totalTokens, previous.kpis.totalTokens),
    },
    efficiency: calculateEfficiencyMetrics(current.kpis, getInclusiveDayCount(filters)),
    modelCostMover: modelCostMover && modelCostMover.deltaUsd > 0 ? modelCostMover : null,
    monthlyCostProjection: projectMonthlyCost(monthUsage.kpis.estimatedCostUsd, monthRange, now),
    previous: previous.kpis,
    previousRange,
    unusualSession,
  };
}

export function getProjects(
  database: AppDatabase,
  filters: DashboardFilters,
  now = new Date(),
): ProjectsResponse {
  const values: ProjectSummary[] = [];
  const projectRows = database.select().from(projects).orderBy(projects.displayName).all();
  for (const project of projectRows) {
    if (filters.projectId && project.id !== filters.projectId) continue;
    const projectFilters = { ...filters, projectId: project.id };
    const dashboard = getDashboard(database, projectFilters, now);
    if (dashboard.kpis.totalTokens === 0 && dashboard.kpis.requestCount === 0) continue;
    const subagent = getDashboard(database, { ...projectFilters, agentKind: "subagent" }, now);
    const topSessions = getSessions(database, {
      ...projectFilters,
      order: "desc",
      page: 1,
      pageSize: 5,
      sort: "cost",
    }).sessions;
    values.push({
      ...dashboard.kpis,
      daily: dashboard.daily,
      displayName: project.displayName,
      displayPath: project.displayPath,
      id: project.id,
      modelMix: dashboard.models.map((model) => ({
        model: model.model,
        totalTokens: model.totalTokens,
      })),
      subagentCostUsd: subagent.kpis.estimatedCostUsd,
      subagentShare:
        dashboard.kpis.totalTokens === 0
          ? 0
          : subagent.kpis.totalTokens / dashboard.kpis.totalTokens,
      subagentTokens: subagent.kpis.totalTokens,
      topSessions,
    });
  }
  values.sort((left, right) => right.totalTokens - left.totalTokens);
  return { projects: values };
}

export function getAgents(
  database: AppDatabase,
  filters: AgentFilters,
  now = new Date(),
): AgentsResponse {
  const rows = readAgentUsageRows(database, filters);
  const metadata = new Map(
    database
      .select()
      .from(sessionAgents)
      .all()
      .map((agent) => [agent.id, agent]),
  );
  const aggregates = new Map<
    string,
    Omit<AgentUsageSummary, "models" | "projectIds" | "sessionCount"> & {
      models: Set<string>;
      projectIds: Set<string>;
      sessionIds: Set<string>;
    }
  >();
  const includedRows: AgentUsageRow[] = [];

  for (const row of rows) {
    const agent = metadata.get(row.agentId);
    if (filters.role && agent?.role !== filters.role) continue;
    if (filters.depth !== undefined && agent?.depth !== filters.depth) continue;
    includedRows.push(row);
    const current = aggregates.get(row.agentId) ?? {
      agentId: row.agentId,
      cachedInputTokens: 0,
      depth: agent?.depth ?? (row.agentKind === "subagent" ? 1 : 0),
      estimatedCostUsd: 0,
      firstEventAt: row.firstEventAt,
      inputTokens: 0,
      isSubagent: row.agentKind === "subagent",
      lastEventAt: row.lastEventAt,
      models: new Set<string>(),
      name: agent?.name ?? null,
      outputTokens: 0,
      parentAgentId: agent?.parentThreadId ?? null,
      projectIds: new Set<string>(),
      reasoningOutputTokens: 0,
      requestCount: 0,
      role: agent?.role ?? null,
      sessionIds: new Set<string>(),
      sourceDeleted: agent?.sourceDeleted ?? true,
      taskSummary: agent?.taskSummary ?? null,
      totalTokens: 0,
      unpricedUsageCount: 0,
    };
    current.cachedInputTokens += row.cachedInputTokens;
    current.estimatedCostUsd += row.costUsd;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.reasoningOutputTokens += row.reasoningOutputTokens;
    current.requestCount += row.requestCount;
    current.totalTokens += row.totalTokens;
    current.unpricedUsageCount += row.unpricedUsageCount;
    current.firstEventAt = minDate(current.firstEventAt ?? row.firstEventAt, row.firstEventAt);
    current.lastEventAt = maxDate(current.lastEventAt ?? row.lastEventAt, row.lastEventAt);
    current.models.add(row.model);
    current.projectIds.add(row.projectId);
    current.sessionIds.add(row.sessionId);
    aggregates.set(row.agentId, current);
  }

  const agents = [...aggregates.values()]
    .map<AgentUsageSummary>(({ models, projectIds, sessionIds, ...agent }) => ({
      ...agent,
      models: [...models].sort(),
      projectIds: [...projectIds].sort(),
      sessionCount: sessionIds.size,
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens);
  const metadataFiltered = Boolean(filters.role) || filters.depth !== undefined;
  let main: DashboardKpis;
  let subagent: DashboardKpis;
  let daily: AgentsResponse["daily"];
  if (metadataFiltered) {
    main = summarizeAgentRows(includedRows, "main");
    subagent = summarizeAgentRows(includedRows, "subagent");
    const dates = [...new Set(includedRows.map((row) => row.localDate))].sort();
    daily = dates.map((date) => {
      const rows = includedRows.filter((row) => row.localDate === date);
      return {
        date,
        main: summarizeAgentRows(rows, "main"),
        subagent: summarizeAgentRows(rows, "subagent"),
      };
    });
  } else {
    const mainDashboard =
      filters.agentKind === "subagent"
        ? null
        : getDashboard(database, { ...filters, agentKind: "main" }, now);
    const subagentDashboard =
      filters.agentKind === "main"
        ? null
        : getDashboard(database, { ...filters, agentKind: "subagent" }, now);
    main = mainDashboard?.kpis ?? summarizeAgentRows([], "main");
    subagent = subagentDashboard?.kpis ?? summarizeAgentRows([], "subagent");
    const mainByDate = new Map(mainDashboard?.daily.map((row) => [row.date, row]) ?? []);
    const subagentByDate = new Map(subagentDashboard?.daily.map((row) => [row.date, row]) ?? []);
    const dates = [...new Set([...mainByDate.keys(), ...subagentByDate.keys()])].sort();
    daily = dates.map((date) => ({
      date,
      main: mainByDate.get(date) ?? summarizeAgentRows([], "main"),
      subagent: subagentByDate.get(date) ?? summarizeAgentRows([], "subagent"),
    }));
  }
  return { agents, coverage: getSessionCoverage(filters, now), daily, main, subagent };
}

export function getBudgets(database: AppDatabase): BudgetSetting[] {
  const stored = new Map(
    database
      .select()
      .from(budgetSettings)
      .all()
      .map((budget) => [budget.period, budget]),
  );
  return (["daily", "monthly"] as const).map((period) => {
    const budget = stored.get(period);
    return {
      enabled: budget?.enabled ?? false,
      limitUsd: budget?.limitUsd ?? 0,
      period,
      updatedAt: new Date(budget?.updatedAt ?? 0).toISOString(),
      warningThresholds: parseThresholds(budget?.warningThresholds),
    };
  });
}

export function saveBudget(
  database: AppDatabase,
  value: Omit<BudgetSetting, "updatedAt">,
): BudgetSetting {
  const updatedAt = Date.now();
  database
    .insert(budgetSettings)
    .values({
      enabled: value.enabled,
      limitUsd: value.limitUsd,
      period: value.period,
      updatedAt,
      warningThresholds: JSON.stringify(value.warningThresholds),
    })
    .onConflictDoUpdate({
      target: budgetSettings.period,
      set: {
        enabled: value.enabled,
        limitUsd: value.limitUsd,
        updatedAt,
        warningThresholds: JSON.stringify(value.warningThresholds),
      },
    })
    .run();
  return { ...value, updatedAt: new Date(updatedAt).toISOString() };
}

export function refreshAlerts(database: AppDatabase, now = new Date()): AlertEvent[] {
  const today = currentLocalDate(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  for (const budget of getBudgets(database)) {
    if (!budget.enabled || budget.limitUsd <= 0) continue;
    const from = budget.period === "daily" ? today : monthStart;
    const usage = getDashboard(database, { from, to: today }, now).kpis.estimatedCostUsd;
    const percent = (usage / budget.limitUsd) * 100;
    for (const threshold of budget.warningThresholds.filter((value) => percent >= value)) {
      upsertAlert(database, {
        message: `${formatUsd(usage)} / ${formatUsd(budget.limitUsd)} (${percent.toFixed(1)}%).`,
        periodStart: from,
        scopeKey: `${budget.period}:${threshold}`,
        severity: threshold >= 100 ? "critical" : threshold >= 80 ? "warning" : "info",
        title: `${budget.period === "daily" ? "Ngân sách ngày" : "Ngân sách tháng"} đã đạt ${threshold}%`,
        type: "budget",
      });
    }
  }

  const insightFrom = dateDaysBefore(today, 13);
  for (const anomaly of getInsights(database, { from: insightFrom, to: today }, now).anomalies) {
    upsertAlert(database, {
      message: `${anomaly.kind === "cost" ? "Cost" : "Token"} ${anomaly.value.toLocaleString("en-US")} cao hơn baseline 14 ngày.`,
      periodStart: anomaly.date,
      scopeKey: `${anomaly.date}:${anomaly.kind}`,
      severity: "warning",
      title: "Phát hiện usage bất thường",
      type: "anomaly",
    });
  }
  const pressuredTurns = database.$client
    .prepare(
      `select
        t.model_context_window as contextWindow,
        t.local_date as localDate,
        t.peak_input_tokens as peakInput,
        t.turn_id as turnId,
        t.id as turnKey
      from turns t
      left join alert_events a
        on a.type = 'context-pressure'
        and a.scope_key = t.id
        and a.period_start = t.local_date
      where t.model_context_window > 0
        and t.peak_input_tokens is not null
        and t.peak_input_tokens * 100.0 / t.model_context_window >= 70
        and (
          a.id is null
          or (case a.severity when 'critical' then 3 when 'warning' then 2 else 1 end) <
             (case
                when t.peak_input_tokens * 100.0 / t.model_context_window >= 95 then 3
                when t.peak_input_tokens * 100.0 / t.model_context_window >= 85 then 2
                else 1
              end)
        )
      order by t.local_date desc, t.id asc
      limit ?`,
    )
    .all(ALERT_MATERIALIZATION_BATCH) as {
    contextWindow: number;
    localDate: string;
    peakInput: number;
    turnId: string;
    turnKey: string;
  }[];
  for (const turn of pressuredTurns) {
    if (!turn.contextWindow || turn.peakInput === null) continue;
    const percent = (turn.peakInput / turn.contextWindow) * 100;
    const threshold = percent >= 95 ? 95 : percent >= 85 ? 85 : 70;
    upsertAlert(database, {
      message: `Peak input đạt ${percent.toFixed(1)}% context window. Đây là chỉ số gần đúng theo request lớn nhất.`,
      periodStart: turn.localDate,
      scopeKey: turn.turnKey,
      severity: threshold >= 95 ? "critical" : threshold >= 85 ? "warning" : "info",
      title: `Turn ${shortId(turn.turnId)} đã vượt ${threshold}% context`,
      turnKey: turn.turnKey,
      type: "context-pressure",
    });
  }
  return listAlerts(database);
}

function listAlerts(database: AppDatabase): AlertEvent[] {
  return database
    .select()
    .from(alertEvents)
    .where(isNull(alertEvents.dismissedAt))
    .orderBy(desc(alertEvents.createdAt))
    .limit(ALERT_FEED_LIMIT)
    .all()
    .map(toAlertEvent);
}

export function getAlertFeed(database: AppDatabase, now = new Date()) {
  const alerts = refreshAlerts(database, now);
  const row = database.$client
    .prepare(
      "select count(*) as count from alert_events where dismissed_at is null and seen_at is null",
    )
    .get() as { count: number } | undefined;
  return { alerts, unseenCount: Number(row?.count ?? 0) };
}

export function updateAlert(
  database: AppDatabase,
  id: string,
  action: "dismiss" | "seen",
): AlertEvent | null {
  database
    .update(alertEvents)
    .set(action === "dismiss" ? { dismissedAt: Date.now() } : { seenAt: Date.now() })
    .where(eq(alertEvents.id, id))
    .run();
  const value = database.select().from(alertEvents).where(eq(alertEvents.id, id)).get();
  return value ? toAlertEvent(value) : null;
}

export function simulatePricing(
  database: AppDatabase,
  request: PricingSimulationRequest,
): PricingSimulationResponse {
  const dashboard = getDashboard(database, request);
  const rateByModel = new Map(request.rates.map((rate) => [rate.model, rate]));
  const simulatedCostUsd = dashboard.models.reduce((total, model) => {
    const rate = rateByModel.get(model.model);
    if (!rate) return total + model.estimatedCostUsd;
    return (
      total +
      ((model.inputTokens - model.cachedInputTokens) * rate.inputRate +
        model.cachedInputTokens * rate.cachedInputRate +
        model.outputTokens * rate.outputRate) /
        1_000_000
    );
  }, 0);
  return {
    currentCostUsd: dashboard.kpis.estimatedCostUsd,
    deltaUsd: simulatedCostUsd - dashboard.kpis.estimatedCostUsd,
    simulatedCostUsd,
  };
}

export function exportDataset(
  database: AppDatabase,
  dataset: "agents" | "models" | "projects" | "sessions",
  filters: ExportFilters,
  format: "csv" | "json",
): { body: string; contentType: string; filename: string } {
  const values: Record<string, unknown>[] =
    dataset === "models"
      ? getDashboard(database, filters).models
      : dataset === "projects"
        ? getProjects(database, filters).projects
        : dataset === "agents"
          ? getAgents(database, filters).agents
          : getAllSessions(database, filters);
  const body = format === "json" ? JSON.stringify(values, null, 2) : toCsv(values);
  return {
    body,
    contentType: format === "json" ? "application/json" : "text/csv; charset=utf-8",
    filename: `codex-usage-${dataset}.${format}`,
  };
}

export function exportTurnDataset(
  database: AppDatabase,
  filters: TurnFilters,
  format: "csv" | "json",
): { body: ReadableStream<Uint8Array>; contentType: string; filename: string } {
  const encoder = new TextEncoder();
  const base = toTurnExportFilters(filters);
  let emitted = 0;
  let page = 1;
  let started = false;
  let headers: string[] | null = null;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const response = getTurnPage(database, { ...base, page, pageSize: 100 });
        const rows: object[] = response.turns;
        const done = rows.length === 0 || emitted + rows.length >= response.total;
        let chunk = "";

        if (format === "json") {
          chunk = started ? "" : "[";
          for (const row of rows) {
            if (emitted > 0) chunk += ",";
            chunk += JSON.stringify(row);
            emitted += 1;
          }
          if (done) chunk += "]";
        } else if (rows.length > 0) {
          const currentHeaders = headers ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
          headers = currentHeaders;
          const lines = rows.map((row) =>
            currentHeaders.map((header) => csvCell(Reflect.get(row, header))).join(","),
          );
          chunk = `${started ? "\n" : `${currentHeaders.map(csvCell).join(",")}\n`}${lines.join("\n")}`;
          emitted += rows.length;
        }

        started = true;
        if (chunk) controller.enqueue(encoder.encode(chunk));
        if (done) controller.close();
        else page += 1;
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    body,
    contentType: format === "json" ? "application/json" : "text/csv; charset=utf-8",
    filename: `codex-usage-turns.${format}`,
  };
}

function getAllSessions(database: AppDatabase, filters: ExportFilters): SessionUsage[] {
  const values: SessionUsage[] = [];
  let page = 1;
  const base = toSessionExportFilters(filters);
  while (true) {
    const response = getSessions(database, { ...base, page, pageSize: 100 });
    values.push(...response.sessions);
    if (values.length >= response.total || response.sessions.length === 0) return values;
    page += 1;
  }
}

function toTurnExportFilters(filters: ExportFilters): TurnFilters {
  const value: TurnFilters = {
    from: filters.from,
    order: filters.order ?? "desc",
    sort:
      filters.sort === "context" || filters.sort === "duration" || filters.sort === "ttft"
        ? filters.sort
        : (filters.sort ?? "lastActivity"),
    to: filters.to,
  };
  copyDashboardFilters(filters, value);
  if ("agentId" in filters && filters.agentId) value.agentId = filters.agentId;
  if ("effort" in filters && filters.effort) value.effort = filters.effort;
  if ("pressure" in filters && filters.pressure) value.pressure = filters.pressure;
  if (filters.query) value.query = filters.query;
  if ("sessionId" in filters && filters.sessionId) value.sessionId = filters.sessionId;
  if ("status" in filters && filters.status) value.status = filters.status;
  return value;
}

function toSessionExportFilters(filters: ExportFilters): SessionFilters {
  const value: SessionFilters = {
    from: filters.from,
    order: filters.order ?? "desc",
    page: 1,
    pageSize: 100,
    sort: filters.sort === "cost" || filters.sort === "tokens" ? filters.sort : "lastActivity",
    to: filters.to,
  };
  copyDashboardFilters(filters, value);
  if ("hasSubagents" in filters && filters.hasSubagents !== undefined) {
    value.hasSubagents = filters.hasSubagents;
  }
  if (filters.query) value.query = filters.query;
  return value;
}

function copyDashboardFilters(source: DashboardFilters, target: DashboardFilters) {
  if (source.agentKind) target.agentKind = source.agentKind;
  if (source.model) target.model = source.model;
  if (source.models) target.models = source.models;
  if (source.projectId) target.projectId = source.projectId;
}

function readAgentUsageRows(database: AppDatabase, filters: DashboardFilters): AgentUsageRow[] {
  const models = filters.models?.length ? filters.models : filters.model ? [filters.model] : [];
  const rawConditions = ["e.local_date >= ?", "e.local_date <= ?"];
  const rawParameters: unknown[] = [filters.from, filters.to];
  const archivedConditions = ["r.local_date >= ?", "r.local_date <= ?"];
  const archivedParameters: unknown[] = [filters.from, filters.to];
  addSqlFilters(
    rawConditions,
    rawParameters,
    archivedConditions,
    archivedParameters,
    filters,
    models,
  );
  const raw = database.$client
    .prepare(
      `select e.agent_id agentId,
        case when a.thread_source = 'subagent' then 'subagent' else 'main' end agentKind,
        e.cached_input_tokens cachedInputTokens, coalesce(e.cost_usd, 0) costUsd,
        e.timestamp firstEventAt, e.input_tokens inputTokens, e.timestamp lastEventAt,
        e.local_date localDate,
        e.model model, e.output_tokens outputTokens, coalesce(s.project_id, 'legacy-unknown') projectId,
        e.reasoning_output_tokens reasoningOutputTokens, 1 requestCount,
        e.session_id sessionId, e.total_tokens totalTokens,
        case when e.cost_usd is null then 1 else 0 end unpricedUsageCount
      from usage_events e
      left join session_agents a on a.id = e.agent_id
      left join sessions s on s.id = e.session_id
      where ${rawConditions.join(" and ")}`,
    )
    .all(...rawParameters) as AgentUsageRow[];
  const archived = database.$client
    .prepare(
      `select r.agent_id agentId, r.agent_kind agentKind,
        r.cached_input_tokens cachedInputTokens, r.cost_usd costUsd,
        r.local_date firstEventAt, r.input_tokens inputTokens, r.local_date lastEventAt,
        r.local_date localDate,
        r.model model, r.output_tokens outputTokens, r.project_id projectId,
        r.reasoning_output_tokens reasoningOutputTokens, r.request_count requestCount,
        r.session_id sessionId, r.total_tokens totalTokens,
        r.unpriced_usage_count unpricedUsageCount
      from usage_agent_daily_rollups r
      where ${archivedConditions.join(" and ")}`,
    )
    .all(...archivedParameters) as AgentUsageRow[];
  return [...raw, ...archived];
}

function summarizeAgentRows(
  rows: AgentUsageRow[],
  agentKind: AgentUsageRow["agentKind"],
): DashboardKpis {
  const sessions = new Set<string>();
  const summary: DashboardKpis = {
    cachedInputTokens: 0,
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    requestCount: 0,
    sessionCount: 0,
    totalTokens: 0,
    unpricedUsageCount: 0,
  };
  for (const row of rows) {
    if (row.agentKind !== agentKind) continue;
    summary.cachedInputTokens += row.cachedInputTokens;
    summary.estimatedCostUsd += row.costUsd;
    summary.inputTokens += row.inputTokens;
    summary.outputTokens += row.outputTokens;
    summary.reasoningOutputTokens += row.reasoningOutputTokens;
    summary.requestCount += row.requestCount;
    summary.totalTokens += row.totalTokens;
    summary.unpricedUsageCount += row.unpricedUsageCount;
    sessions.add(row.sessionId);
  }
  summary.sessionCount = sessions.size;
  return summary;
}

function addSqlFilters(
  rawConditions: string[],
  rawParameters: unknown[],
  archivedConditions: string[],
  archivedParameters: unknown[],
  filters: DashboardFilters,
  models: string[],
) {
  if (models.length > 0) {
    const placeholders = models.map(() => "?").join(",");
    rawConditions.push(`e.model in (${placeholders})`);
    rawParameters.push(...models);
    archivedConditions.push(`r.model in (${placeholders})`);
    archivedParameters.push(...models);
  }
  if (filters.agentKind && filters.agentKind !== "all") {
    rawConditions.push(
      filters.agentKind === "subagent"
        ? "a.thread_source = 'subagent'"
        : "coalesce(a.thread_source, 'user') != 'subagent'",
    );
    archivedConditions.push("r.agent_kind = ?");
    archivedParameters.push(filters.agentKind);
  }
  if (filters.projectId) {
    rawConditions.push("coalesce(s.project_id, 'legacy-unknown') = ?");
    rawParameters.push(filters.projectId);
    archivedConditions.push("r.project_id = ?");
    archivedParameters.push(filters.projectId);
  }
}

function detectDailyAnomalies(
  rows: { cost: number; date: string; tokens: number }[],
  from: string,
  to: string,
): InsightAlert[] {
  const rowByDate = new Map(rows.map((row) => [row.date, row]));
  const earliestObserved = [...rowByDate.keys()].sort().at(0);
  if (!earliestObserved) return [];

  const ordered: { cost: number; date: string; tokens: number }[] = [];
  const baselineStart = dateDaysBefore(from, 14);
  for (
    let date = earliestObserved > baselineStart ? earliestObserved : baselineStart;
    date <= to;
    date = dateDaysBefore(date, -1)
  ) {
    ordered.push(rowByDate.get(date) ?? { cost: 0, date, tokens: 0 });
  }
  const results: InsightAlert[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered.at(index);
    if (!current) continue;
    if (current.date < from || current.date > to) continue;
    const baseline = ordered.slice(Math.max(0, index - 14), index);
    if (
      isUsageAnomaly(
        current.cost,
        baseline.map((row) => row.cost),
      )
    )
      results.push({ date: current.date, kind: "cost", value: current.cost });
    if (
      isUsageAnomaly(
        current.tokens,
        baseline.map((row) => row.tokens),
      )
    )
      results.push({ date: current.date, kind: "tokens", value: current.tokens });
  }
  return results;
}

function detectUnusualSession(
  current: SessionUsage[],
  baseline: SessionUsage[],
): InsightsResponse["unusualSession"] {
  if (baseline.length < 3) return null;
  const baselineCosts = baseline.map((session) => session.estimatedCostUsd);
  const baselineTokens = baseline.map((session) => session.totalTokens);
  const candidates = current
    .map((session) => {
      const reasons: ("cost" | "tokens")[] = [];
      if (isUsageAnomaly(session.estimatedCostUsd, baselineCosts)) reasons.push("cost");
      if (isUsageAnomaly(session.totalTokens, baselineTokens)) reasons.push("tokens");
      return { reasons, session };
    })
    .filter((candidate) => candidate.reasons.length > 0)
    .sort(
      (left, right) =>
        right.session.estimatedCostUsd - left.session.estimatedCostUsd ||
        right.session.totalTokens - left.session.totalTokens,
    );
  const candidate = candidates[0];
  if (!candidate) return null;
  return {
    estimatedCostUsd: candidate.session.estimatedCostUsd,
    reasons: candidate.reasons,
    sessionId: candidate.session.sessionId,
    title: candidate.session.title,
    totalTokens: candidate.session.totalTokens,
  };
}

function metricDelta(current: number, previous: number): MetricDelta {
  return {
    absolute: current - previous,
    percent: previous === 0 ? null : (current - previous) / previous,
  };
}

function parseThresholds(value: string | undefined): number[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[50,80,100]");
    if (!Array.isArray(parsed)) return [50, 80, 100];
    return parsed.filter(
      (threshold): threshold is number =>
        typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0,
    );
  } catch {
    return [50, 80, 100];
  }
}

function upsertAlert(
  database: AppDatabase,
  value: Pick<
    typeof alertEvents.$inferInsert,
    "message" | "periodStart" | "scopeKey" | "severity" | "title" | "type"
  > & { turnKey?: string | null },
) {
  const id = createHash("sha256")
    .update(`${value.type}\u0000${value.scopeKey}\u0000${value.periodStart}`)
    .digest("hex");
  database
    .insert(alertEvents)
    .values({ ...value, createdAt: Date.now(), id })
    .onConflictDoUpdate({
      target: [alertEvents.type, alertEvents.scopeKey, alertEvents.periodStart],
      set: {
        message: value.message,
        severity: value.severity,
        title: value.title,
        turnKey: value.turnKey ?? null,
      },
    })
    .run();
}

function toAlertEvent(value: typeof alertEvents.$inferSelect): AlertEvent {
  return {
    createdAt: new Date(value.createdAt).toISOString(),
    dismissedAt: value.dismissedAt ? new Date(value.dismissedAt).toISOString() : null,
    id: value.id,
    message: value.message,
    periodStart: value.periodStart,
    seenAt: value.seenAt ? new Date(value.seenAt).toISOString() : null,
    severity: value.severity as AlertEvent["severity"],
    title: value.title,
    turnKey: value.turnKey,
    type: value.type as AlertEvent["type"],
  };
}

function shortId(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) =>
      headers.map((header) => csvCell(flattenValue(Reflect.get(row, header)))).join(","),
    ),
  ].join("\n");
}

function flattenValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

function csvCell(value: unknown): string {
  let text = flattenValue(value);
  // Spreadsheet applications may ignore leading whitespace before evaluating a formula.
  // Prefix every formula-like cell so exported local metadata cannot trigger CSV injection.
  if (/^[\t\r\n ]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" }).format(value);
}

function minDate(left: string, right: string): string {
  return left <= right ? left : right;
}

function maxDate(left: string, right: string): string {
  return left >= right ? left : right;
}
