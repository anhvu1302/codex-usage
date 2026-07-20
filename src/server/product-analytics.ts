import { createHash } from "node:crypto";

import { desc, eq, isNull } from "drizzle-orm";

import {
  getDashboard,
  getSessionAnomalyRows,
  getSessions,
  getTopSessionsByProject,
  type SessionAnomalyRow,
} from "@/server/analytics";
import type { AppDatabase } from "@/server/db/client";
import {
  alertEvents,
  budgetSettings,
  projectBudgetSettings,
  projects,
  sessionAgents,
} from "@/server/db/schema";
import {
  calculateEfficiencyMetrics,
  createUsageAnomalyDetector,
  getInclusiveDayCount,
  getPreviousDateRange,
  isUsageAnomaly,
  projectMonthlyCost,
} from "@/server/insights";
import { currentLocalDate, dateDaysBefore, getSessionCoverage } from "@/server/retention";
import { getTurnPage } from "@/server/turns";
import { getProjectTagMap } from "@/server/tags";
import type {
  AgentFilters,
  AgentLeaderboardItem,
  AgentPageFilters,
  AgentUsageSummary,
  AgentsPageResponse,
  AgentsResponse,
  AgentsSummaryResponse,
  AlertEvent,
  AlertsResponse,
  BudgetSetting,
  DashboardFilters,
  DashboardKpis,
  InsightAlert,
  InsightsResponse,
  MetricDelta,
  OverviewResponse,
  PricingSimulationRequest,
  PricingSimulationResponse,
  ProjectAnalyticsResponse,
  ProjectListItem,
  ProjectPageFilters,
  ProjectSummary,
  ProjectOptionsResponse,
  ProjectsPageResponse,
  ProjectsResponse,
  ProjectsSummaryResponse,
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

type AgentAggregateSqlRow = DashboardKpis & {
  agentKind: "main" | "subagent";
  localDate: string;
  scope: "daily" | "total";
};

type AgentPageSqlRow = {
  agentId: string;
  cachedInputTokens: number;
  depth: number;
  estimatedCostUsd: number;
  inputTokens: number;
  isSubagent: number;
  model: string | null;
  modelCount: number | null;
  name: string | null;
  outputTokens: number;
  requestCount: number;
  role: string | null;
  sessionCount: number;
  totalCount: number;
  totalTokens: number;
};

type ProjectPageSqlRow = DashboardKpis & {
  displayName: string;
  displayPath: string;
  id: string;
  model: string | null;
  modelCount: number | null;
  modelTokens: number | null;
  subagentCostUsd: number;
  subagentTokens: number;
  totalCount: number;
};

type SetBasedUsage = {
  cte: string;
  parameters: (number | string)[];
};

export function getInsights(
  database: AppDatabase,
  filters: DashboardFilters,
  now = new Date(),
): InsightsResponse {
  const current = getDashboard(database, filters, now);
  const previousRange = getPreviousDateRange(filters);
  const previous = getDashboard(database, { ...filters, ...previousRange }, now);
  return buildInsights(database, filters, now, current, previous, previousRange);
}

export function getOverview(
  database: AppDatabase,
  filters: DashboardFilters,
  now = new Date(),
): OverviewResponse {
  const dashboard = getDashboard(database, filters, now);
  const previousRange = getPreviousDateRange(filters);
  const previous = getDashboard(database, { ...filters, ...previousRange }, now);
  return {
    dashboard,
    insights: buildInsights(database, filters, now, dashboard, previous, previousRange),
  };
}

function buildInsights(
  database: AppDatabase,
  filters: DashboardFilters,
  now: Date,
  current: ReturnType<typeof getDashboard>,
  previous: ReturnType<typeof getDashboard>,
  previousRange: ReturnType<typeof getPreviousDateRange>,
): InsightsResponse {
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
  const baselineSessions = getSessionAnomalyRows(
    database,
    {
      ...filters,
      from: baselineFrom,
      to: dateDaysBefore(filters.from, 1),
    },
    now,
  );
  const unusualSession = detectUnusualSession(
    getSessionAnomalyRows(database, filters, now),
    baselineSessions,
  );

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
  const projectRows = new Map(
    database
      .select()
      .from(projects)
      .all()
      .filter((project) => !filters.projectId || project.id === filters.projectId)
      .map((project) => [project.id, project]),
  );
  const rowsByProject = new Map<string, AgentUsageRow[]>();
  const tagsByProject = getProjectTagMap(database, [...projectRows.keys()]);
  for (const row of readAgentUsageRows(database, filters)) {
    if (!projectRows.has(row.projectId)) continue;
    const rows = rowsByProject.get(row.projectId) ?? [];
    rows.push(row);
    rowsByProject.set(row.projectId, rows);
  }
  const topSessions = getTopSessionsByProject(database, filters, 5, now);
  const values: ProjectSummary[] = [];
  for (const [projectId, rows] of rowsByProject) {
    const project = projectRows.get(projectId);
    if (!project) continue;
    const kpis = summarizeUsageRows(rows);
    const subagent = summarizeUsageRows(rows.filter((row) => row.agentKind === "subagent"));
    const dailyRows = groupRows(rows, (row) => row.localDate);
    const modelRows = groupRows(rows, (row) => row.model);
    values.push({
      ...kpis,
      daily: [...dailyRows]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, dateRows]) => ({ date, ...summarizeUsageRows(dateRows) })),
      displayName: project.displayName,
      displayPath: project.displayPath,
      id: project.id,
      modelMix: [...modelRows]
        .map(([model, modelUsage]) => ({
          model,
          totalTokens: summarizeUsageRows(modelUsage).totalTokens,
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens),
      subagentCostUsd: subagent.estimatedCostUsd,
      subagentShare: kpis.totalTokens === 0 ? 0 : subagent.totalTokens / kpis.totalTokens,
      subagentTokens: subagent.totalTokens,
      tags: tagsByProject.get(project.id) ?? [],
      topSessions: topSessions.get(project.id) ?? [],
    });
  }
  values.sort((left, right) => right.totalTokens - left.totalTokens);
  return { projects: values };
}

export function getProjectsSummary(
  database: AppDatabase,
  filters: DashboardFilters,
): ProjectsSummaryResponse {
  const usage = buildSetBasedUsage(filters);
  const row = database.$client
    .prepare(
      `${usage.cte}
      select
        count(distinct u.projectId) as projectCount,
        coalesce(sum(u.inputTokens), 0) as inputTokens,
        coalesce(sum(u.cachedInputTokens), 0) as cachedInputTokens,
        coalesce(sum(u.outputTokens), 0) as outputTokens,
        coalesce(sum(u.reasoningOutputTokens), 0) as reasoningOutputTokens,
        coalesce(sum(u.totalTokens), 0) as totalTokens,
        coalesce(sum(u.requestCount), 0) as requestCount,
        count(distinct u.sessionId) as sessionCount,
        coalesce(sum(u.costUsd), 0) as estimatedCostUsd,
        coalesce(sum(u.unpricedUsageCount), 0) as unpricedUsageCount
      from usage_rows u
      join projects p on p.id = u.projectId`,
    )
    .get(...usage.parameters) as (DashboardKpis & { projectCount: number }) | undefined;
  return {
    kpis: toDashboardKpis(row),
    projectCount: toNumber(row?.projectCount),
  };
}

export function getProjectsPage(
  database: AppDatabase,
  filters: ProjectPageFilters,
): ProjectsPageResponse {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;
  const usage = buildSetBasedUsage(filters);
  const rows = database.$client
    .prepare(
      `${usage.cte}, project_totals as (
        select
          u.projectId as id,
          p.display_name as displayName,
          p.display_path as displayPath,
          coalesce(sum(u.inputTokens), 0) as inputTokens,
          coalesce(sum(u.cachedInputTokens), 0) as cachedInputTokens,
          coalesce(sum(u.outputTokens), 0) as outputTokens,
          coalesce(sum(u.reasoningOutputTokens), 0) as reasoningOutputTokens,
          coalesce(sum(u.totalTokens), 0) as totalTokens,
          coalesce(sum(u.requestCount), 0) as requestCount,
          count(distinct u.sessionId) as sessionCount,
          coalesce(sum(u.costUsd), 0) as estimatedCostUsd,
          coalesce(sum(u.unpricedUsageCount), 0) as unpricedUsageCount,
          coalesce(sum(case when u.agentKind = 'subagent' then u.totalTokens else 0 end), 0) as subagentTokens,
          coalesce(sum(case when u.agentKind = 'subagent' then u.costUsd else 0 end), 0) as subagentCostUsd
        from usage_rows u
        join projects p on p.id = u.projectId
        group by u.projectId, p.display_name, p.display_path
      ), ranked_projects as (
        select *,
          count(*) over() as totalCount,
          row_number() over (order by totalTokens desc, id asc) as rankPosition
        from project_totals
      ), paged_projects as (
        select * from ranked_projects
        where rankPosition > ? and rankPosition <= ?
      ), model_totals as (
        select u.projectId as id, u.model as model, coalesce(sum(u.totalTokens), 0) as totalTokens
        from usage_rows u
        join paged_projects p on p.id = u.projectId
        group by u.projectId, u.model
      ), ranked_models as (
        select *,
          count(*) over (partition by id) as modelCount,
          row_number() over (partition by id order by totalTokens desc, model asc) as modelRank
        from model_totals
      )
      select p.*, m.model, m.totalTokens as modelTokens, m.modelCount, m.modelRank
      from paged_projects p
      left join ranked_models m on m.id = p.id and m.modelRank <= 2
      order by p.rankPosition, m.modelRank`,
    )
    .all(...usage.parameters, offset, offset + pageSize) as ProjectPageSqlRow[];
  let total = toNumber(rows[0]?.totalCount);
  if (rows.length === 0 && page > 1) {
    const totalRow = database.$client
      .prepare(
        `${usage.cte}
        select count(distinct u.projectId) as count
        from usage_rows u
        join projects p on p.id = u.projectId`,
      )
      .get(...usage.parameters) as { count: number } | undefined;
    total = toNumber(totalRow?.count);
  }
  const projectsById = new Map<string, ProjectListItem>();
  const tagsByProject = getProjectTagMap(database, [...new Set(rows.map((row) => row.id))]);
  for (const row of rows) {
    const project = projectsById.get(row.id) ?? {
      ...toDashboardKpis(row),
      displayName: row.displayName,
      displayPath: row.displayPath,
      id: row.id,
      modelCount: toNumber(row.modelCount),
      subagentCostUsd: toNumber(row.subagentCostUsd),
      subagentShare: safeRatio(toNumber(row.subagentTokens), toNumber(row.totalTokens)),
      subagentTokens: toNumber(row.subagentTokens),
      tags: tagsByProject.get(row.id) ?? [],
      topModels: [],
    };
    if (row.model) {
      project.topModels.push({ model: row.model, totalTokens: toNumber(row.modelTokens) });
    }
    projectsById.set(row.id, project);
  }
  return { page, pageSize, projects: [...projectsById.values()], total };
}

export function getProjectAnalytics(
  database: AppDatabase,
  id: string,
  filters: DashboardFilters,
  now = new Date(),
): ProjectAnalyticsResponse | null {
  const project = getProjects(database, { ...filters, projectId: id }, now).projects.find(
    (value) => value.id === id,
  );
  return project ? { project } : null;
}

export function getProjectOptions(
  database: AppDatabase,
  filters: DashboardFilters,
): ProjectOptionsResponse {
  const models = [
    ...new Set(filters.models?.length ? filters.models : filters.model ? [filters.model] : []),
  ];
  const rawConditions = ["e.local_date >= ?", "e.local_date <= ?", "s.project_id is not null"];
  const rawParameters: (number | string)[] = [filters.from, filters.to];
  const archivedConditions = ["d.local_date >= ?", "d.local_date <= ?"];
  const archivedParameters: (number | string)[] = [filters.from, filters.to];
  if (models.length > 0) {
    const placeholders = models.map(() => "?").join(", ");
    rawConditions.push(`e.model in (${placeholders})`);
    archivedConditions.push(`d.model in (${placeholders})`);
    rawParameters.push(...models);
    archivedParameters.push(...models);
  }
  if (filters.agentKind && filters.agentKind !== "all") {
    rawConditions.push(
      `exists (
        select 1 from session_agents sa
        where sa.id = e.agent_id
          and sa.thread_source ${filters.agentKind === "subagent" ? "=" : "!="} 'subagent'
      )`,
    );
    archivedConditions.push("d.agent_kind = ?");
    archivedParameters.push(filters.agentKind);
  }
  if (filters.projectId) {
    rawConditions.push("s.project_id = ?");
    archivedConditions.push("d.project_id = ?");
    rawParameters.push(filters.projectId);
    archivedParameters.push(filters.projectId);
  }
  if (filters.tagIds?.length) {
    const placeholders = filters.tagIds.map(() => "?").join(", ");
    rawConditions.push(
      `exists (
        select 1 from project_tags tag_filter
        where tag_filter.project_id = s.project_id
          and tag_filter.tag_id in (${placeholders})
      )`,
    );
    archivedConditions.push(
      `exists (
        select 1 from project_tags tag_filter
        where tag_filter.project_id = d.project_id
          and tag_filter.tag_id in (${placeholders})
      )`,
    );
    rawParameters.push(...filters.tagIds);
    archivedParameters.push(...filters.tagIds);
  }

  const rows = database.$client
    .prepare(
      `with used_projects(project_id) as (
        select distinct s.project_id
        from usage_events e
        join sessions s on s.id = e.session_id
        where ${rawConditions.join(" and ")}
        union
        select distinct d.project_id
        from usage_daily_rollups d
        where ${archivedConditions.join(" and ")}
      )
      select p.id as id, p.display_name as displayName
      from projects p
      join used_projects u on u.project_id = p.id
      order by p.display_name collate nocase, p.id`,
    )
    .all(...rawParameters, ...archivedParameters) as { displayName: string; id: string }[];
  return { projects: rows };
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

export function getAgentsSummary(
  database: AppDatabase,
  filters: AgentFilters,
  now = new Date(),
): AgentsSummaryResponse {
  const usage = buildSetBasedUsage(filters);
  const totalRow = database.$client
    .prepare(`${usage.cte} select count(distinct agentId) as count from usage_rows`)
    .get(...usage.parameters) as { count: number } | undefined;
  const metadataFiltered = Boolean(filters.role) || filters.depth !== undefined;
  if (!metadataFiltered) {
    const mainDashboard =
      filters.agentKind === "subagent"
        ? null
        : getDashboard(database, { ...filters, agentKind: "main" }, now);
    const subagentDashboard =
      filters.agentKind === "main"
        ? null
        : getDashboard(database, { ...filters, agentKind: "subagent" }, now);
    const mainByDate = new Map(mainDashboard?.daily.map((row) => [row.date, row]) ?? []);
    const subagentByDate = new Map(subagentDashboard?.daily.map((row) => [row.date, row]) ?? []);
    const dates = [...new Set([...mainByDate.keys(), ...subagentByDate.keys()])].sort();
    return {
      coverage: getSessionCoverage(filters, now),
      daily: dates.map((date) => ({
        date,
        main: mainByDate.get(date) ?? emptyDashboardKpis(),
        subagent: subagentByDate.get(date) ?? emptyDashboardKpis(),
      })),
      main: mainDashboard?.kpis ?? emptyDashboardKpis(),
      subagent: subagentDashboard?.kpis ?? emptyDashboardKpis(),
      totalAgents: toNumber(totalRow?.count),
    };
  }

  const rows = database.$client
    .prepare(
      `${usage.cte}
      select
        'daily' as scope,
        localDate,
        agentKind,
        coalesce(sum(inputTokens), 0) as inputTokens,
        coalesce(sum(cachedInputTokens), 0) as cachedInputTokens,
        coalesce(sum(outputTokens), 0) as outputTokens,
        coalesce(sum(reasoningOutputTokens), 0) as reasoningOutputTokens,
        coalesce(sum(totalTokens), 0) as totalTokens,
        coalesce(sum(requestCount), 0) as requestCount,
        count(distinct sessionId) as sessionCount,
        coalesce(sum(costUsd), 0) as estimatedCostUsd,
        coalesce(sum(unpricedUsageCount), 0) as unpricedUsageCount
      from usage_rows
      group by localDate, agentKind
      union all
      select
        'total' as scope,
        '' as localDate,
        agentKind,
        coalesce(sum(inputTokens), 0) as inputTokens,
        coalesce(sum(cachedInputTokens), 0) as cachedInputTokens,
        coalesce(sum(outputTokens), 0) as outputTokens,
        coalesce(sum(reasoningOutputTokens), 0) as reasoningOutputTokens,
        coalesce(sum(totalTokens), 0) as totalTokens,
        coalesce(sum(requestCount), 0) as requestCount,
        count(distinct sessionId) as sessionCount,
        coalesce(sum(costUsd), 0) as estimatedCostUsd,
        coalesce(sum(unpricedUsageCount), 0) as unpricedUsageCount
      from usage_rows
      group by agentKind
      order by scope, localDate, agentKind`,
    )
    .all(...usage.parameters) as AgentAggregateSqlRow[];
  const dailyRows = rows.filter((row) => row.scope === "daily");
  const dates = [...new Set(dailyRows.map((row) => row.localDate))];
  return {
    coverage: getSessionCoverage(filters, now),
    daily: dates.map((date) => ({
      date,
      main: toDashboardKpis(
        dailyRows.find((row) => row.localDate === date && row.agentKind === "main"),
      ),
      subagent: toDashboardKpis(
        dailyRows.find((row) => row.localDate === date && row.agentKind === "subagent"),
      ),
    })),
    main: toDashboardKpis(rows.find((row) => row.scope === "total" && row.agentKind === "main")),
    subagent: toDashboardKpis(
      rows.find((row) => row.scope === "total" && row.agentKind === "subagent"),
    ),
    totalAgents: toNumber(totalRow?.count),
  };
}

export function getAgentsPage(
  database: AppDatabase,
  filters: AgentPageFilters,
): AgentsPageResponse {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const sort = filters.sort ?? "tokens";
  const order = filters.order ?? "desc";
  const direction = order === "asc" ? "asc" : "desc";
  const sortExpression =
    sort === "cache"
      ? "cacheRate"
      : sort === "cost"
        ? "estimatedCostUsd"
        : sort === "output"
          ? "outputTokens"
          : sort === "requests"
            ? "requestCount"
            : "totalTokens";
  const offset = (page - 1) * pageSize;
  const usage = buildSetBasedUsage(filters);
  const rows = database.$client
    .prepare(
      `${usage.cte}, agent_totals as (
        select
          u.agentId as agentId,
          coalesce(a.name, null) as name,
          coalesce(a.role, null) as role,
          coalesce(a.depth, case when max(u.agentKind) = 'subagent' then 1 else 0 end) as depth,
          max(case when u.agentKind = 'subagent' then 1 else 0 end) as isSubagent,
          coalesce(sum(u.inputTokens), 0) as inputTokens,
          coalesce(sum(u.cachedInputTokens), 0) as cachedInputTokens,
          coalesce(sum(u.outputTokens), 0) as outputTokens,
          coalesce(sum(u.totalTokens), 0) as totalTokens,
          coalesce(sum(u.requestCount), 0) as requestCount,
          count(distinct u.sessionId) as sessionCount,
          coalesce(sum(u.costUsd), 0) as estimatedCostUsd,
          case when coalesce(sum(u.inputTokens), 0) > 0
            then coalesce(sum(u.cachedInputTokens), 0) * 1.0 / sum(u.inputTokens)
            else 0 end as cacheRate
        from usage_rows u
        left join session_agents a on a.id = u.agentId
        group by u.agentId, a.name, a.role, a.depth
      ), ranked_agents as (
        select *,
          count(*) over() as totalCount,
          row_number() over (order by ${sortExpression} ${direction}, agentId asc) as rankPosition
        from agent_totals
      ), paged_agents as (
        select * from ranked_agents
        where rankPosition > ? and rankPosition <= ?
      ), model_totals as (
        select u.agentId as agentId, u.model as model, coalesce(sum(u.totalTokens), 0) as totalTokens
        from usage_rows u
        join paged_agents p on p.agentId = u.agentId
        group by u.agentId, u.model
      ), ranked_models as (
        select *,
          count(*) over (partition by agentId) as modelCount,
          row_number() over (partition by agentId order by totalTokens desc, model asc) as modelRank
        from model_totals
      )
      select p.*, m.model, m.modelCount, m.modelRank
      from paged_agents p
      left join ranked_models m on m.agentId = p.agentId and m.modelRank <= 2
      order by p.rankPosition, m.modelRank`,
    )
    .all(...usage.parameters, offset, offset + pageSize) as AgentPageSqlRow[];
  let total = toNumber(rows[0]?.totalCount);
  if (rows.length === 0 && page > 1) {
    const totalRow = database.$client
      .prepare(`${usage.cte} select count(distinct agentId) as count from usage_rows`)
      .get(...usage.parameters) as { count: number } | undefined;
    total = toNumber(totalRow?.count);
  }
  const agentsById = new Map<string, AgentLeaderboardItem>();
  for (const row of rows) {
    const agent = agentsById.get(row.agentId) ?? {
      agentId: row.agentId,
      cachedInputTokens: toNumber(row.cachedInputTokens),
      depth: toNumber(row.depth),
      estimatedCostUsd: toNumber(row.estimatedCostUsd),
      inputTokens: toNumber(row.inputTokens),
      isSubagent: Boolean(row.isSubagent),
      modelCount: toNumber(row.modelCount),
      name: row.name,
      outputTokens: toNumber(row.outputTokens),
      requestCount: toNumber(row.requestCount),
      role: row.role,
      sessionCount: toNumber(row.sessionCount),
      topModels: [],
      totalTokens: toNumber(row.totalTokens),
    };
    if (row.model) agent.topModels.push(row.model);
    agentsById.set(row.agentId, agent);
  }
  return { agents: [...agentsById.values()], order, page, pageSize, sort, total };
}

export function getBudgets(database: AppDatabase, projectId?: string): BudgetSetting[] {
  const stored = new Map(
    database
      .select()
      .from(budgetSettings)
      .all()
      .map((budget) => [budget.period, budget]),
  );
  const globalBudgets = (["daily", "monthly"] as const).map((period) => {
    const budget = stored.get(period);
    return {
      enabled: budget?.enabled ?? false,
      limitUsd: budget?.limitUsd ?? 0,
      period,
      scope: { kind: "global" } as const,
      updatedAt: new Date(budget?.updatedAt ?? 0).toISOString(),
      warningThresholds: parseThresholds(budget?.warningThresholds),
    };
  });

  if (!projectId) return globalBudgets;
  const projectStored = new Map(
    database
      .select()
      .from(projectBudgetSettings)
      .where(eq(projectBudgetSettings.projectId, projectId))
      .all()
      .map((budget) => [budget.period, budget]),
  );
  return [
    ...globalBudgets,
    ...(["daily", "monthly"] as const).map((period) => {
      const budget = projectStored.get(period);
      return {
        enabled: budget?.enabled ?? false,
        limitUsd: budget?.limitUsd ?? 0,
        period,
        scope: { kind: "project", projectId } as const,
        updatedAt: new Date(budget?.updatedAt ?? 0).toISOString(),
        warningThresholds: parseThresholds(budget?.warningThresholds),
      };
    }),
  ];
}

export function saveBudget(
  database: AppDatabase,
  value: Omit<BudgetSetting, "scope" | "updatedAt"> & {
    scope?: BudgetSetting["scope"] | undefined;
  },
): BudgetSetting | null {
  const updatedAt = Date.now();
  const scope = value.scope ?? ({ kind: "global" } as const);
  if (scope.kind === "project") {
    if (!projectExists(database, scope.projectId)) return null;
    database
      .insert(projectBudgetSettings)
      .values({
        enabled: value.enabled,
        limitUsd: value.limitUsd,
        period: value.period,
        projectId: scope.projectId,
        updatedAt,
        warningThresholds: JSON.stringify(value.warningThresholds),
      })
      .onConflictDoUpdate({
        target: [projectBudgetSettings.projectId, projectBudgetSettings.period],
        set: {
          enabled: value.enabled,
          limitUsd: value.limitUsd,
          updatedAt,
          warningThresholds: JSON.stringify(value.warningThresholds),
        },
      })
      .run();
    return { ...value, scope, updatedAt: new Date(updatedAt).toISOString() };
  }
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
  return { ...value, scope, updatedAt: new Date(updatedAt).toISOString() };
}

export function projectExists(database: AppDatabase, projectId: string): boolean {
  return Boolean(
    database.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get(),
  );
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

  const projectBudgets = database
    .select({
      displayName: projects.displayName,
      enabled: projectBudgetSettings.enabled,
      limitUsd: projectBudgetSettings.limitUsd,
      period: projectBudgetSettings.period,
      projectId: projectBudgetSettings.projectId,
      warningThresholds: projectBudgetSettings.warningThresholds,
    })
    .from(projectBudgetSettings)
    .innerJoin(projects, eq(projectBudgetSettings.projectId, projects.id))
    .where(eq(projectBudgetSettings.enabled, true))
    .all();
  if (projectBudgets.length > 0) {
    const dailyUsage = getProjectCostTotals(database, today, today);
    const monthlyUsage = getProjectCostTotals(database, monthStart, today);
    for (const budget of projectBudgets) {
      if (budget.limitUsd <= 0) continue;
      const period = budget.period === "monthly" ? "monthly" : "daily";
      const from = period === "daily" ? today : monthStart;
      const usage = (period === "daily" ? dailyUsage : monthlyUsage).get(budget.projectId) ?? 0;
      const percent = (usage / budget.limitUsd) * 100;
      for (const threshold of parseThresholds(budget.warningThresholds).filter(
        (value) => percent >= value,
      )) {
        upsertAlert(database, {
          message: `${budget.displayName}: ${formatUsd(usage)} / ${formatUsd(budget.limitUsd)} (${percent.toFixed(1)}%).`,
          periodStart: from,
          scopeKey: `project:${budget.projectId}:${period}:${threshold}`,
          severity: threshold >= 100 ? "critical" : threshold >= 80 ? "warning" : "info",
          title: `${budget.displayName} · ${period === "daily" ? "ngân sách ngày" : "ngân sách tháng"} đạt ${threshold}%`,
          type: "budget",
        });
      }
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

function getProjectCostTotals(
  database: AppDatabase,
  from: string,
  to: string,
): Map<string, number> {
  const rows = database.$client
    .prepare(
      `with project_usage as (
        select
          coalesce(s.project_id, 'legacy-unknown') as projectId,
          coalesce(sum(e.cost_usd), 0) as costUsd
        from usage_events e
        left join sessions s on s.id = e.session_id
        where e.local_date >= ? and e.local_date <= ?
        group by coalesce(s.project_id, 'legacy-unknown')
        union all
        select
          r.project_id as projectId,
          coalesce(sum(r.cost_usd), 0) as costUsd
        from usage_daily_rollups r
        where r.local_date >= ? and r.local_date <= ?
        group by r.project_id
      )
      select projectId, coalesce(sum(costUsd), 0) as costUsd
      from project_usage
      group by projectId`,
    )
    .all(from, to, from, to) as { costUsd: number; projectId: string }[];
  return new Map(rows.map((row) => [row.projectId, toNumber(row.costUsd)]));
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

export function getAlertFeed(database: AppDatabase, now = new Date()): AlertsResponse {
  void now;
  const alerts = listAlerts(database);
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

export function dismissAllAlerts(database: AppDatabase): number {
  return database
    .update(alertEvents)
    .set({ dismissedAt: Date.now() })
    .where(isNull(alertEvents.dismissedAt))
    .run().changes;
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
  if (source.tagIds) target.tagIds = source.tagIds;
}

function buildSetBasedUsage(filters: AgentFilters): SetBasedUsage {
  const models = [
    ...new Set(filters.models?.length ? filters.models : filters.model ? [filters.model] : []),
  ];
  const rawConditions = ["e.local_date >= ?", "e.local_date <= ?"];
  const rawParameters: (number | string)[] = [filters.from, filters.to];
  const archivedConditions = ["r.local_date >= ?", "r.local_date <= ?"];
  const archivedParameters: (number | string)[] = [filters.from, filters.to];
  if (models.length > 0) {
    const placeholders = models.map(() => "?").join(", ");
    rawConditions.push(`e.model in (${placeholders})`);
    archivedConditions.push(`r.model in (${placeholders})`);
    rawParameters.push(...models);
    archivedParameters.push(...models);
  }
  if (filters.agentKind && filters.agentKind !== "all") {
    rawConditions.push(
      `case when a.thread_source = 'subagent' then 'subagent' else 'main' end = ?`,
    );
    archivedConditions.push("r.agent_kind = ?");
    rawParameters.push(filters.agentKind);
    archivedParameters.push(filters.agentKind);
  }
  if (filters.projectId) {
    rawConditions.push("coalesce(s.project_id, 'legacy-unknown') = ?");
    archivedConditions.push("r.project_id = ?");
    rawParameters.push(filters.projectId);
    archivedParameters.push(filters.projectId);
  }
  if (filters.tagIds?.length) {
    const placeholders = filters.tagIds.map(() => "?").join(", ");
    rawConditions.push(
      `exists (
        select 1 from project_tags tag_filter
        where tag_filter.project_id = s.project_id
          and tag_filter.tag_id in (${placeholders})
      )`,
    );
    archivedConditions.push(
      `exists (
        select 1 from project_tags tag_filter
        where tag_filter.project_id = r.project_id
          and tag_filter.tag_id in (${placeholders})
      )`,
    );
    rawParameters.push(...filters.tagIds);
    archivedParameters.push(...filters.tagIds);
  }
  if (filters.role) {
    rawConditions.push("a.role = ?");
    archivedConditions.push("a.role = ?");
    rawParameters.push(filters.role);
    archivedParameters.push(filters.role);
  }
  if (filters.depth !== undefined) {
    rawConditions.push("a.depth = ?");
    archivedConditions.push("a.depth = ?");
    rawParameters.push(filters.depth);
    archivedParameters.push(filters.depth);
  }

  return {
    cte: `with raw_usage as (
      select
        e.local_date as localDate,
        e.agent_id as agentId,
        case when a.thread_source = 'subagent' then 'subagent' else 'main' end as agentKind,
        e.session_id as sessionId,
        e.model as model,
        coalesce(s.project_id, 'legacy-unknown') as projectId,
        coalesce(sum(e.input_tokens), 0) as inputTokens,
        coalesce(sum(e.cached_input_tokens), 0) as cachedInputTokens,
        coalesce(sum(e.output_tokens), 0) as outputTokens,
        coalesce(sum(e.reasoning_output_tokens), 0) as reasoningOutputTokens,
        coalesce(sum(e.total_tokens), 0) as totalTokens,
        count(e.id) as requestCount,
        coalesce(sum(e.cost_usd), 0) as costUsd,
        coalesce(sum(case when e.cost_usd is null then 1 else 0 end), 0) as unpricedUsageCount
      from usage_events e
      left join session_agents a on a.id = e.agent_id
      left join sessions s on s.id = e.session_id
      where ${rawConditions.join(" and ")}
      group by e.local_date, e.agent_id, a.thread_source, e.session_id, e.model, s.project_id
    ), archived_usage as (
      select
        r.local_date as localDate,
        r.agent_id as agentId,
        r.agent_kind as agentKind,
        r.session_id as sessionId,
        r.model as model,
        r.project_id as projectId,
        r.input_tokens as inputTokens,
        r.cached_input_tokens as cachedInputTokens,
        r.output_tokens as outputTokens,
        r.reasoning_output_tokens as reasoningOutputTokens,
        r.total_tokens as totalTokens,
        r.request_count as requestCount,
        r.cost_usd as costUsd,
        r.unpriced_usage_count as unpricedUsageCount
      from usage_agent_daily_rollups r
      left join session_agents a on a.id = r.agent_id
      where ${archivedConditions.join(" and ")}
    ), usage_rows as (
      select * from raw_usage
      union all
      select * from archived_usage
    )`,
    parameters: [...rawParameters, ...archivedParameters],
  };
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
        coalesce(sum(e.cached_input_tokens), 0) cachedInputTokens,
        coalesce(sum(e.cost_usd), 0) costUsd,
        min(e.timestamp) firstEventAt,
        coalesce(sum(e.input_tokens), 0) inputTokens,
        max(e.timestamp) lastEventAt,
        e.local_date localDate,
        e.model model,
        coalesce(sum(e.output_tokens), 0) outputTokens,
        coalesce(s.project_id, 'legacy-unknown') projectId,
        coalesce(sum(e.reasoning_output_tokens), 0) reasoningOutputTokens,
        count(e.id) requestCount,
        e.session_id sessionId,
        coalesce(sum(e.total_tokens), 0) totalTokens,
        coalesce(sum(case when e.cost_usd is null then 1 else 0 end), 0) unpricedUsageCount
      from usage_events e
      left join session_agents a on a.id = e.agent_id
      left join sessions s on s.id = e.session_id
      where ${rawConditions.join(" and ")}
      group by e.agent_id, a.thread_source, e.local_date, e.model, s.project_id, e.session_id`,
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
  return summarizeUsageRows(rows.filter((row) => row.agentKind === agentKind));
}

function summarizeUsageRows(rows: AgentUsageRow[]): DashboardKpis {
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

function groupRows<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const values = grouped.get(value) ?? [];
    values.push(row);
    grouped.set(value, values);
  }
  return grouped;
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
  if (filters.tagIds?.length) {
    const placeholders = filters.tagIds.map(() => "?").join(",");
    rawConditions.push(
      `exists (
        select 1 from project_tags tag_filter
        where tag_filter.project_id = s.project_id
          and tag_filter.tag_id in (${placeholders})
      )`,
    );
    archivedConditions.push(
      `exists (
        select 1 from project_tags tag_filter
        where tag_filter.project_id = r.project_id
          and tag_filter.tag_id in (${placeholders})
      )`,
    );
    rawParameters.push(...filters.tagIds);
    archivedParameters.push(...filters.tagIds);
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
  current: SessionAnomalyRow[],
  baseline: SessionAnomalyRow[],
): InsightsResponse["unusualSession"] {
  if (baseline.length < 3) return null;
  const isCostAnomaly = createUsageAnomalyDetector(
    baseline.map((session) => session.estimatedCostUsd),
  );
  const isTokenAnomaly = createUsageAnomalyDetector(baseline.map((session) => session.totalTokens));
  const candidates = current
    .map((session) => {
      const reasons: ("cost" | "tokens")[] = [];
      if (isCostAnomaly(session.estimatedCostUsd)) reasons.push("cost");
      if (isTokenAnomaly(session.totalTokens)) reasons.push("tokens");
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

function emptyDashboardKpis(): DashboardKpis {
  return {
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
}

function toDashboardKpis(value: Partial<DashboardKpis> | null | undefined): DashboardKpis {
  return {
    cachedInputTokens: toNumber(value?.cachedInputTokens),
    estimatedCostUsd: toNumber(value?.estimatedCostUsd),
    inputTokens: toNumber(value?.inputTokens),
    outputTokens: toNumber(value?.outputTokens),
    reasoningOutputTokens: toNumber(value?.reasoningOutputTokens),
    requestCount: toNumber(value?.requestCount),
    sessionCount: toNumber(value?.sessionCount),
    totalTokens: toNumber(value?.totalTokens),
    unpricedUsageCount: toNumber(value?.unpricedUsageCount),
  };
}

function safeRatio(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

function toNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
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
