import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import type { AppDatabase } from "@/server/db/client";
import {
  modelRates,
  projectTags,
  sessionAgents,
  sessions,
  turnModelUsage,
  usageAgentDailyRollups,
  usageDailyRollups,
  usageEvents,
  usageHourlyRollups,
  usageRollupSessionMemberships,
} from "@/server/db/schema";
import { currentLocalDate, getRetentionCoverage, getSessionCoverage } from "@/server/retention";
import { TURN_ATTRIBUTION_VERSION } from "@/server/turn-constants";
import type {
  DashboardFilters,
  DashboardKpis,
  DashboardResponse,
  DailyMinuteReportResponse,
  MinuteModelCall,
  MinuteUsageBucket,
  ModelRate,
  SessionAgentUsage,
  SessionFilters,
  SessionSummariesResponse,
  SessionSummary,
  SessionUsage,
  SessionsResponse,
} from "@/shared/types";

export type SessionAnomalyRow = {
  estimatedCostUsd: number;
  sessionId: string;
  title: string | null;
  totalTokens: number;
};

const MINUTE_REPORT_BUCKET_MINUTES = 5 as const;
const MINUTE_REPORT_TIME_ZONE = "Asia/Ho_Chi_Minh" as const;
const LOCAL_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: MINUTE_REPORT_TIME_ZONE,
});

export function getDailyMinuteReport(
  database: AppDatabase,
  filters: DashboardFilters,
  now = new Date(),
): DailyMinuteReportResponse {
  const availableDate = currentLocalDate(now);
  const generatedAt = now.toISOString();
  if (filters.from !== filters.to || filters.from !== availableDate) {
    return {
      available: false,
      availableDate,
      bucketMinutes: MINUTE_REPORT_BUCKET_MINUTES,
      buckets: [],
      date: filters.from,
      generatedAt,
      modelCalls: [],
      timeZone: MINUTE_REPORT_TIME_ZONE,
    };
  }

  const localMinute = sql<string>`printf(
    '%02d:%02d',
    cast(strftime('%H', datetime(${usageEvents.timestamp}, '+7 hours')) as integer),
    (cast(strftime('%M', datetime(${usageEvents.timestamp}, '+7 hours')) as integer) / 5) * 5
  )`;
  const rows = database
    .select({ minute: localMinute, ...aggregateFields })
    .from(usageEvents)
    .where(usageWhere(filters))
    .groupBy(localMinute)
    .all();
  const modelCalls = database
    .select({
      minute: localMinute,
      model: usageEvents.model,
      requestCount: rawAggregateFields.requestCount,
    })
    .from(usageEvents)
    .where(usageWhere(filters))
    .groupBy(localMinute, usageEvents.model)
    .all()
    .map((row): MinuteModelCall => ({
      minute: row.minute,
      model: row.model,
      requestCount: toNumber(row.requestCount),
    }))
    .sort(
      (left, right) =>
        left.minute.localeCompare(right.minute) ||
        right.requestCount - left.requestCount ||
        left.model.localeCompare(right.model),
    );
  const usageByMinute = new Map(
    rows.map((row) => [row.minute, { minute: row.minute, ...toKpis(row) }]),
  );
  const currentMinute = localMinuteOfDay(now);
  const lastBucketMinute =
    Math.floor(currentMinute / MINUTE_REPORT_BUCKET_MINUTES) * MINUTE_REPORT_BUCKET_MINUTES;
  const buckets = Array.from(
    { length: lastBucketMinute / MINUTE_REPORT_BUCKET_MINUTES + 1 },
    (_, index): MinuteUsageBucket => {
      const minuteOfDay = index * MINUTE_REPORT_BUCKET_MINUTES;
      const key = minuteLabel(minuteOfDay);
      return usageByMinute.get(key) ?? { minute: key, ...emptyDashboardKpis() };
    },
  );

  return {
    available: true,
    availableDate,
    bucketMinutes: MINUTE_REPORT_BUCKET_MINUTES,
    buckets,
    date: filters.from,
    generatedAt,
    modelCalls,
    timeZone: MINUTE_REPORT_TIME_ZONE,
  };
}

export function getDashboard(
  database: AppDatabase,
  filters: DashboardFilters,
  now = new Date(),
): DashboardResponse {
  const identities = getDailySessionIdentities(database, filters);
  const allSessions = new Set(identities.map((identity) => identity.sessionId));
  const sessionsByDate = groupIdentitySets(identities, (identity) => identity.date);
  const sessionsByModel = groupIdentitySets(identities, (identity) => identity.model);
  const dailyModelRows = getDailyModelRows(database, filters);
  const rowsByDate = groupUsageRows(dailyModelRows, (row) => row.date);
  const rowsByModel = groupUsageRows(dailyModelRows, (row) => row.model);
  const kpis = sumUsageRows(dailyModelRows, allSessions.size);
  const daily = [...rowsByDate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, rows]) => ({
      date,
      ...sumUsageRows(rows, sessionsByDate.get(date)?.size ?? 0),
    }));
  const models = [...rowsByModel]
    .map(([model, rows]) => {
      const usage = sumUsageRows(rows, sessionsByModel.get(model)?.size ?? 0);
      return {
        model,
        tokenShare: kpis.totalTokens === 0 ? 0 : usage.totalTokens / kpis.totalTokens,
        ...usage,
      };
    })
    .sort((left, right) => right.totalTokens - left.totalTokens);
  const retention = getRetentionCoverage(filters, now);
  const hourlyRows = retention.hourlyAvailable ? getHourlyModelRows(database, filters) : [];
  const hourlySessions = retention.hourlyAvailable
    ? groupIdentitySets(getHourlySessionIdentities(database, filters), (identity) => identity.hour)
    : new Map<string, Set<string>>();
  const rowsByHour = groupUsageRows(hourlyRows, (row) => row.hour);

  return {
    daily,
    dailyModels: dailyModelRows.map((row) => ({
      date: row.date,
      estimatedCostUsd: row.estimatedCostUsd,
      model: row.model,
      requestCount: row.requestCount,
      totalTokens: row.totalTokens,
    })),
    hourly: retention.hourlyAvailable
      ? Array.from({ length: 24 }, (_, hour) => {
          const key = `${String(hour).padStart(2, "0")}:00`;
          return {
            hour: key,
            ...sumUsageRows(rowsByHour.get(key) ?? [], hourlySessions.get(key)?.size ?? 0),
          };
        })
      : [],
    hourlyModels: hourlyRows.map((row) => ({
      estimatedCostUsd: row.estimatedCostUsd,
      hour: row.hour,
      model: row.model,
      requestCount: row.requestCount,
      totalTokens: row.totalTokens,
    })),
    kpis,
    models,
    retention,
  };
}

type DailyModelRow = UsageValues & { date: string; model: string };
type HourlyModelRow = UsageValues & { hour: string; model: string };
type SessionIdentity = { date: string; model: string; sessionId: string };
type HourlySessionIdentity = { hour: string; model: string; sessionId: string };
type UsageValues = Omit<DashboardKpis, "sessionCount">;

function getDailyModelRows(database: AppDatabase, filters: DashboardFilters): DailyModelRow[] {
  const raw = database
    .select({ date: usageEvents.localDate, model: usageEvents.model, ...rawAggregateFields })
    .from(usageEvents)
    .where(usageWhere(filters))
    .groupBy(usageEvents.localDate, usageEvents.model)
    .all()
    .map((row) => ({ date: row.date, model: row.model, ...toUsageValues(row) }));
  const archived = database
    .select({
      date: usageDailyRollups.localDate,
      model: usageDailyRollups.model,
      ...dailyRollupAggregateFields,
    })
    .from(usageDailyRollups)
    .where(dailyRollupWhere(filters))
    .groupBy(usageDailyRollups.localDate, usageDailyRollups.model)
    .all()
    .map((row) => ({ date: row.date, model: row.model, ...toUsageValues(row) }));
  return mergeUsageRows([...raw, ...archived], (row) => `${row.date}\u0000${row.model}`);
}

function getHourlyModelRows(database: AppDatabase, filters: DashboardFilters): HourlyModelRow[] {
  const localHour = sql<string>`strftime('%H', datetime(${usageEvents.timestamp}, '+7 hours'))`;
  const raw = database
    .select({ hour: localHour, model: usageEvents.model, ...rawAggregateFields })
    .from(usageEvents)
    .where(usageWhere(filters))
    .groupBy(localHour, usageEvents.model)
    .all()
    .map((row) => ({ hour: `${row.hour}:00`, model: row.model, ...toUsageValues(row) }));
  const archived = database
    .select({
      hour: usageHourlyRollups.localHour,
      model: usageHourlyRollups.model,
      ...hourlyRollupAggregateFields,
    })
    .from(usageHourlyRollups)
    .where(hourlyRollupWhere(filters))
    .groupBy(usageHourlyRollups.localHour, usageHourlyRollups.model)
    .all()
    .map((row) => ({ hour: row.hour, model: row.model, ...toUsageValues(row) }));
  return mergeUsageRows([...raw, ...archived], (row) => `${row.hour}\u0000${row.model}`);
}

export function getSessions(
  database: AppDatabase,
  filters: SessionFilters,
  now = new Date(),
): SessionsResponse {
  const result = readSessionPage(database, filters, now);
  const agentsBySession = new Map<string, SessionAgentUsage[]>();
  for (const agent of getSessionAgents(
    database,
    result.effectiveFilters,
    result.rows.map((row) => row.sessionId),
  )) {
    const agents = agentsBySession.get(agent.sessionId) ?? [];
    agents.push(agent);
    agentsBySession.set(agent.sessionId, agents);
  }
  return {
    coverage: result.coverage,
    page: result.page,
    pageSize: result.pageSize,
    sessions: result.rows.map((row) => ({
      ...toSessionUsage(row),
      agents: agentsBySession.get(row.sessionId) ?? [],
    })),
    total: result.total,
  };
}

export function getSessionSummaries(
  database: AppDatabase,
  filters: SessionFilters,
  now = new Date(),
): SessionSummariesResponse {
  const result = readSessionPage(database, filters, now);
  const names = getSubagentNames(
    database,
    result.rows.map((row) => row.sessionId),
  );
  return {
    coverage: result.coverage,
    page: result.page,
    pageSize: result.pageSize,
    sessions: result.rows.map<SessionSummary>((row) => ({
      ...toSessionUsage(row),
      agentCount: toNumber(row.agentCount),
      subagentCount: toNumber(row.subagentCount),
      subagentNames: names.get(row.sessionId) ?? [],
    })),
    total: result.total,
  };
}

export function getSessionDetail(
  database: AppDatabase,
  sessionId: string,
  filters: DashboardFilters,
  now = new Date(),
): SessionUsage | null {
  const result = readSessionPage(database, { ...filters, page: 1, pageSize: 1 }, now, sessionId);
  const row = result.rows[0];
  if (!row) return null;
  const agents = getSessionAgents(database, result.effectiveFilters, [sessionId]).map(
    ({ sessionId: importedSessionId, ...agent }) => {
      void importedSessionId;
      return agent;
    },
  );
  return { ...toSessionUsage(row), agents };
}

export function getSessionAnomalyRows(
  database: AppDatabase,
  filters: DashboardFilters,
  now = new Date(),
): SessionAnomalyRow[] {
  const scope = buildRawSessionScope(filters, now);
  if (!scope) return [];
  return database.$client
    .prepare(
      `select
        e.session_id as sessionId,
        s.title as title,
        coalesce(sum(e.total_tokens), 0) as totalTokens,
        coalesce(sum(e.cost_usd), 0) as estimatedCostUsd
      from usage_events e
      join sessions s on s.id = e.session_id
      where ${scope.usageConditions.join(" and ")}
      group by e.session_id, s.title
      order by max(e.timestamp) desc, e.session_id desc`,
    )
    .all(...scope.parameters) as SessionAnomalyRow[];
}

export function getTopSessionsByProject(
  database: AppDatabase,
  filters: DashboardFilters,
  limit = 5,
  now = new Date(),
): Map<string, SessionUsage[]> {
  const result = new Map<string, SessionUsage[]>();
  const coverage = getSessionCoverage(filters, now);
  if (!coverage.from || !coverage.to || limit < 1) return result;
  const effectiveFilters: DashboardFilters = {
    ...(filters.agentKind ? { agentKind: filters.agentKind } : {}),
    from: coverage.from,
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.models ? { models: filters.models } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.tagIds ? { tagIds: filters.tagIds } : {}),
    to: coverage.to,
  };
  const conditions = ["e.local_date >= ?", "e.local_date <= ?", "s.project_id is not null"];
  const parameters: (number | string)[] = [coverage.from, coverage.to];
  const models = selectedModels(effectiveFilters);
  if (models.length > 0) {
    conditions.push(`e.model in (${models.map(() => "?").join(", ")})`);
    parameters.push(...models);
  }
  if (effectiveFilters.agentKind && effectiveFilters.agentKind !== "all") {
    conditions.push(
      `exists (
        select 1 from session_agents agent_filter
        where agent_filter.id = e.agent_id
          and agent_filter.thread_source ${effectiveFilters.agentKind === "subagent" ? "=" : "!="} 'subagent'
      )`,
    );
  }
  if (effectiveFilters.projectId) {
    conditions.push("s.project_id = ?");
    parameters.push(effectiveFilters.projectId);
  }
  if (effectiveFilters.tagIds?.length) {
    conditions.push(
      `exists (
        select 1 from project_tags tag_filter
        where tag_filter.project_id = s.project_id
          and tag_filter.tag_id in (${effectiveFilters.tagIds.map(() => "?").join(", ")})
      )`,
    );
    parameters.push(...effectiveFilters.tagIds);
  }

  const rows = database.$client
    .prepare(
      `with aggregated as (
        select
          e.session_id as sessionId,
          s.project_id as projectId,
          min(e.timestamp) as firstEventAt,
          max(e.timestamp) as lastEventAt,
          group_concat(distinct e.model) as models,
          coalesce(sum(e.input_tokens), 0) as inputTokens,
          coalesce(sum(e.cached_input_tokens), 0) as cachedInputTokens,
          coalesce(sum(e.output_tokens), 0) as outputTokens,
          coalesce(sum(e.reasoning_output_tokens), 0) as reasoningOutputTokens,
          coalesce(sum(e.total_tokens), 0) as totalTokens,
          count(e.id) as requestCount,
          coalesce(sum(e.cost_usd), 0) as estimatedCostUsd,
          coalesce(sum(case when e.cost_usd is null then 1 else 0 end), 0) as unpricedUsageCount
        from usage_events e
        join sessions s on s.id = e.session_id
        where ${conditions.join(" and ")}
        group by e.session_id, s.project_id
      ), session_rows as (
        select
          a.*,
          s.cwd as cwd,
          s.source_deleted as sourceDeleted,
          s.title as title,
          1 as sessionCount,
          (select count(*) from session_agents counts where counts.session_id = a.sessionId) as agentCount,
          (select count(*) from session_agents counts where counts.session_id = a.sessionId and counts.thread_source = 'subagent') as subagentCount
        from aggregated a
        join sessions s on s.id = a.sessionId
      ), ranked as (
        select *, row_number() over (
          partition by projectId
          order by estimatedCostUsd desc, sessionId desc
        ) as projectRank
        from session_rows
      )
      select * from ranked
      where projectRank <= ?
      order by projectId, projectRank`,
    )
    .all(...parameters, limit) as (SessionPageRow & { projectRank: number })[];

  const agentsBySession = new Map<string, SessionAgentUsage[]>();
  for (const agent of getSessionAgents(
    database,
    effectiveFilters,
    rows.map((row) => row.sessionId),
  )) {
    const agents = agentsBySession.get(agent.sessionId) ?? [];
    agents.push(agent);
    agentsBySession.set(agent.sessionId, agents);
  }
  for (const row of rows) {
    if (!row.projectId) continue;
    const sessions = result.get(row.projectId) ?? [];
    sessions.push({
      ...toSessionUsage(row),
      agents: agentsBySession.get(row.sessionId) ?? [],
    });
    result.set(row.projectId, sessions);
  }
  return result;
}

type SessionPageRow = {
  agentCount: number;
  cachedInputTokens: number;
  cwd: string | null;
  estimatedCostUsd: number;
  firstEventAt: string;
  inputTokens: number;
  lastEventAt: string;
  models: string;
  outputTokens: number;
  projectId: string | null;
  reasoningOutputTokens: number;
  requestCount: number;
  sessionCount: number;
  sessionId: string;
  sourceDeleted: number | boolean;
  subagentCount: number;
  title: string | null;
  totalTokens: number;
  unpricedUsageCount: number;
};

type SessionPageRowWithTotal = SessionPageRow & { totalCount: number };

function readSessionPage(
  database: AppDatabase,
  filters: SessionFilters,
  now: Date,
  onlySessionId?: string,
) {
  const coverage = getSessionCoverage(filters, now);
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const empty = {
    coverage,
    effectiveFilters: { from: filters.from, to: filters.to } satisfies DashboardFilters,
    page,
    pageSize,
    rows: [] as SessionPageRow[],
    total: 0,
  };
  const scope = buildRawSessionScope(filters, now);
  if (!scope) return empty;
  const { effectiveFilters, parameters, usageConditions } = scope;

  const sessionConditions: string[] = [];
  if (onlySessionId) {
    sessionConditions.push("sessionId = ?");
    parameters.push(onlySessionId);
  }
  const query = filters.query?.trim().toLocaleLowerCase();
  if (query) {
    sessionConditions.push(`(
      instr(lower(coalesce(title, '')), ?) > 0
      or instr(lower(sessionId), ?) > 0
      or instr(lower(coalesce(cwd, '')), ?) > 0
      or exists (
        select 1 from session_agents search_agent
        where search_agent.session_id = sessionId
          and (
            instr(lower(coalesce(search_agent.name, '')), ?) > 0
            or instr(lower(coalesce(search_agent.role, '')), ?) > 0
          )
      )
    )`);
    parameters.push(query, query, query, query, query);
  }
  if (filters.hasSubagents !== undefined) {
    sessionConditions.push(filters.hasSubagents ? "subagentCount > 0" : "subagentCount = 0");
  }
  const filteredWhere =
    sessionConditions.length > 0 ? `where ${sessionConditions.join(" and ")}` : "";
  const commonTableExpression = `with aggregated as (
    select
      e.session_id as sessionId,
      min(e.timestamp) as firstEventAt,
      max(e.timestamp) as lastEventAt,
      group_concat(distinct e.model) as models,
      coalesce(sum(e.input_tokens), 0) as inputTokens,
      coalesce(sum(e.cached_input_tokens), 0) as cachedInputTokens,
      coalesce(sum(e.output_tokens), 0) as outputTokens,
      coalesce(sum(e.reasoning_output_tokens), 0) as reasoningOutputTokens,
      coalesce(sum(e.total_tokens), 0) as totalTokens,
      count(e.id) as requestCount,
      coalesce(sum(e.cost_usd), 0) as estimatedCostUsd,
      coalesce(sum(case when e.cost_usd is null then 1 else 0 end), 0) as unpricedUsageCount
    from usage_events e
    join sessions s on s.id = e.session_id
    where ${usageConditions.join(" and ")}
    group by e.session_id
  ), session_rows as (
    select
      a.*,
      s.cwd as cwd,
      s.project_id as projectId,
      s.source_deleted as sourceDeleted,
      s.title as title,
      1 as sessionCount,
      (select count(*) from session_agents counts where counts.session_id = a.sessionId) as agentCount,
      (select count(*) from session_agents counts where counts.session_id = a.sessionId and counts.thread_source = 'subagent') as subagentCount
    from aggregated a
    join sessions s on s.id = a.sessionId
  ), filtered_sessions as (
    select * from session_rows ${filteredWhere}
  )`;
  const direction = filters.order === "asc" ? "asc" : "desc";
  const sortColumn =
    filters.sort === "tokens"
      ? "totalTokens"
      : filters.sort === "cost"
        ? "estimatedCostUsd"
        : "lastEventAt";
  const rows = database.$client
    .prepare(
      `${commonTableExpression}
       select *, count(*) over() as totalCount from filtered_sessions
       order by ${sortColumn} ${direction}, sessionId ${direction}
       limit ? offset ?`,
    )
    .all(...parameters, pageSize, (page - 1) * pageSize) as SessionPageRowWithTotal[];
  let total = toNumber(rows[0]?.totalCount);
  if (rows.length === 0 && page > 1) {
    const totalRow = database.$client
      .prepare(`${commonTableExpression} select count(*) as count from filtered_sessions`)
      .get(...parameters) as { count: number } | undefined;
    total = toNumber(totalRow?.count);
  }
  return {
    coverage,
    effectiveFilters,
    page,
    pageSize,
    rows,
    total,
  };
}

function buildRawSessionScope(
  filters: DashboardFilters,
  now: Date,
): {
  coverage: ReturnType<typeof getSessionCoverage>;
  effectiveFilters: DashboardFilters;
  parameters: (number | string)[];
  usageConditions: string[];
} | null {
  const coverage = getSessionCoverage(filters, now);
  if (!coverage.from || !coverage.to) return null;
  const effectiveFilters: DashboardFilters = {
    ...(filters.agentKind ? { agentKind: filters.agentKind } : {}),
    from: coverage.from,
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.models ? { models: filters.models } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.tagIds ? { tagIds: filters.tagIds } : {}),
    to: coverage.to,
  };
  const usageConditions = ["e.local_date >= ?", "e.local_date <= ?"];
  const parameters: (number | string)[] = [coverage.from, coverage.to];
  const models = selectedModels(effectiveFilters);
  if (models.length > 0) {
    usageConditions.push(`e.model in (${models.map(() => "?").join(", ")})`);
    parameters.push(...models);
  }
  if (effectiveFilters.agentKind && effectiveFilters.agentKind !== "all") {
    usageConditions.push(
      `exists (
        select 1 from session_agents agent_filter
        where agent_filter.id = e.agent_id
          and agent_filter.thread_source ${effectiveFilters.agentKind === "subagent" ? "=" : "!="} 'subagent'
      )`,
    );
  }
  if (effectiveFilters.projectId) {
    usageConditions.push("s.project_id = ?");
    parameters.push(effectiveFilters.projectId);
  }
  if (effectiveFilters.tagIds?.length) {
    usageConditions.push(
      `exists (
        select 1 from project_tags tag_filter
        where tag_filter.project_id = s.project_id
          and tag_filter.tag_id in (${effectiveFilters.tagIds.map(() => "?").join(", ")})
      )`,
    );
    parameters.push(...effectiveFilters.tagIds);
  }
  return { coverage, effectiveFilters, parameters, usageConditions };
}

function toSessionUsage(row: SessionPageRow): Omit<SessionUsage, "agents"> {
  return {
    cwd: row.cwd,
    firstEventAt: row.firstEventAt,
    lastEventAt: row.lastEventAt,
    models: row.models.split(",").filter(Boolean).sort(),
    projectId: row.projectId,
    sessionId: row.sessionId,
    sourceDeleted: Boolean(row.sourceDeleted),
    title: row.title,
    ...toKpis(row),
  };
}

function getSubagentNames(database: AppDatabase, sessionIds: string[]): Map<string, string[]> {
  const names = new Map<string, string[]>();
  if (sessionIds.length === 0) return names;
  const rows = database.$client
    .prepare(
      `with unique_names as (
        select distinct session_id as sessionId, name
        from session_agents
        where thread_source = 'subagent'
          and name is not null
          and trim(name) != ''
          and session_id in (${sessionIds.map(() => "?").join(", ")})
      ), ranked as (
        select sessionId, name,
          row_number() over (partition by sessionId order by name collate nocase, name) as rank
        from unique_names
      )
      select sessionId, name from ranked where rank <= 2 order by sessionId, rank`,
    )
    .all(...sessionIds) as { name: string; sessionId: string }[];
  for (const row of rows) {
    const values = names.get(row.sessionId) ?? [];
    values.push(row.name);
    names.set(row.sessionId, values);
  }
  return names;
}

function getSessionAgents(
  database: AppDatabase,
  filters: DashboardFilters,
  sessionIds: string[],
): (SessionAgentUsage & { sessionId: string })[] {
  if (sessionIds.length === 0) return [];
  const rows = database
    .select({
      agentId: sessionAgents.id,
      depth: sessionAgents.depth,
      firstEventAt: sql<string | null>`min(${usageEvents.timestamp})`,
      lastEventAt: sql<string | null>`max(${usageEvents.timestamp})`,
      models: sql<string | null>`group_concat(distinct ${usageEvents.model})`,
      name: sessionAgents.name,
      parentAgentId: sessionAgents.parentThreadId,
      role: sessionAgents.role,
      sessionId: sessionAgents.sessionId,
      sourceDeleted: sessionAgents.sourceDeleted,
      taskSummary: sessionAgents.taskSummary,
      threadSource: sessionAgents.threadSource,
      ...aggregateFields,
    })
    .from(sessionAgents)
    .leftJoin(usageEvents, and(eq(usageEvents.agentId, sessionAgents.id), usageWhere(filters)))
    .where(inArray(sessionAgents.sessionId, sessionIds))
    .groupBy(
      sessionAgents.id,
      sessionAgents.depth,
      sessionAgents.name,
      sessionAgents.parentThreadId,
      sessionAgents.role,
      sessionAgents.sessionId,
      sessionAgents.sourceDeleted,
      sessionAgents.taskSummary,
      sessionAgents.threadSource,
    )
    .all();

  return rows.map((row) => {
    const kpis = toKpis(row);
    return {
      agentId: row.agentId,
      cachedInputTokens: kpis.cachedInputTokens,
      depth: row.depth,
      estimatedCostUsd: kpis.estimatedCostUsd,
      firstEventAt: row.firstEventAt,
      inputTokens: kpis.inputTokens,
      isSubagent: row.threadSource === "subagent",
      lastEventAt: row.lastEventAt,
      models: row.models?.split(",").filter(Boolean) ?? [],
      name: row.name,
      outputTokens: kpis.outputTokens,
      parentAgentId: row.parentAgentId,
      reasoningOutputTokens: kpis.reasoningOutputTokens,
      requestCount: kpis.requestCount,
      role: row.role,
      sessionId: row.sessionId,
      sourceDeleted: row.sourceDeleted,
      taskSummary: row.taskSummary,
      totalTokens: kpis.totalTokens,
      unpricedUsageCount: kpis.unpricedUsageCount,
    };
  });
}

function getDailySessionIdentities(
  database: AppDatabase,
  filters: DashboardFilters,
): SessionIdentity[] {
  const raw = database
    .select({
      date: usageEvents.localDate,
      model: usageEvents.model,
      sessionId: usageEvents.sessionId,
    })
    .from(usageEvents)
    .where(usageWhere(filters))
    .groupBy(usageEvents.localDate, usageEvents.model, usageEvents.sessionId)
    .all();
  const archived = database
    .select({
      date: usageRollupSessionMemberships.bucketStart,
      model: usageRollupSessionMemberships.model,
      sessionId: usageRollupSessionMemberships.sessionId,
    })
    .from(usageRollupSessionMemberships)
    .where(membershipWhere(filters, "day"))
    .groupBy(
      usageRollupSessionMemberships.bucketStart,
      usageRollupSessionMemberships.model,
      usageRollupSessionMemberships.sessionId,
    )
    .all();
  return uniqueIdentities(
    [...raw, ...archived],
    (row) => `${row.date}\u0000${row.model}\u0000${row.sessionId}`,
  );
}

function getHourlySessionIdentities(
  database: AppDatabase,
  filters: DashboardFilters,
): HourlySessionIdentity[] {
  const localHour = sql<string>`strftime('%H:00', datetime(${usageEvents.timestamp}, '+7 hours'))`;
  const raw = database
    .select({ hour: localHour, model: usageEvents.model, sessionId: usageEvents.sessionId })
    .from(usageEvents)
    .where(usageWhere(filters))
    .groupBy(localHour, usageEvents.model, usageEvents.sessionId)
    .all();
  const archived = database
    .select({
      bucket: usageRollupSessionMemberships.bucketStart,
      model: usageRollupSessionMemberships.model,
      sessionId: usageRollupSessionMemberships.sessionId,
    })
    .from(usageRollupSessionMemberships)
    .where(membershipWhere(filters, "hour"))
    .groupBy(
      usageRollupSessionMemberships.bucketStart,
      usageRollupSessionMemberships.model,
      usageRollupSessionMemberships.sessionId,
    )
    .all()
    .map((row) => ({ hour: row.bucket.slice(11), model: row.model, sessionId: row.sessionId }));
  return uniqueIdentities(
    [...raw, ...archived],
    (row) => `${row.hour}\u0000${row.model}\u0000${row.sessionId}`,
  );
}

function groupIdentitySets<T extends { sessionId: string }>(
  identities: T[],
  key: (identity: T) => string,
): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const identity of identities) {
    const value = key(identity);
    const sessions = groups.get(value) ?? new Set<string>();
    sessions.add(identity.sessionId);
    groups.set(value, sessions);
  }
  return groups;
}

function uniqueIdentities<T>(rows: T[], key: (row: T) => string): T[] {
  return [...new Map(rows.map((row) => [key(row), row])).values()];
}

function groupUsageRows<T extends UsageValues>(
  rows: T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const values = groups.get(value) ?? [];
    values.push(row);
    groups.set(value, values);
  }
  return groups;
}

function mergeUsageRows<T extends UsageValues>(rows: T[], key: (row: T) => string): T[] {
  const merged = new Map<string, T>();
  for (const row of rows) {
    const value = key(row);
    const existing = merged.get(value);
    if (!existing) {
      merged.set(value, { ...row });
      continue;
    }
    addUsageValues(existing, row);
  }
  return [...merged.values()];
}

function sumUsageRows(rows: UsageValues[], sessionCount: number): DashboardKpis {
  const total = emptyUsageValues();
  for (const row of rows) addUsageValues(total, row);
  return { ...total, sessionCount };
}

function addUsageValues(target: UsageValues, value: UsageValues) {
  target.cachedInputTokens += value.cachedInputTokens;
  target.estimatedCostUsd += value.estimatedCostUsd;
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.reasoningOutputTokens += value.reasoningOutputTokens;
  target.requestCount += value.requestCount;
  target.totalTokens += value.totalTokens;
  target.unpricedUsageCount += value.unpricedUsageCount;
}

function emptyUsageValues(): UsageValues {
  return {
    cachedInputTokens: 0,
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    requestCount: 0,
    totalTokens: 0,
    unpricedUsageCount: 0,
  };
}

export function getModelRates(database: AppDatabase): ModelRate[] {
  return database
    .select()
    .from(modelRates)
    .orderBy(asc(modelRates.model))
    .all()
    .map((rate) => ({
      cachedInputRate: rate.cachedInputRate,
      inputRate: rate.inputRate,
      model: rate.model,
      outputRate: rate.outputRate,
      updatedAt: new Date(rate.updatedAt).toISOString(),
    }));
}

export function getKnownModels(database: AppDatabase): string[] {
  const models = new Set<string>();
  for (const row of database
    .select({ model: usageEvents.model })
    .from(usageEvents)
    .groupBy(usageEvents.model)
    .all()) {
    models.add(row.model);
  }
  for (const row of database
    .select({ model: usageDailyRollups.model })
    .from(usageDailyRollups)
    .groupBy(usageDailyRollups.model)
    .all()) {
    models.add(row.model);
  }
  for (const row of database.select({ model: modelRates.model }).from(modelRates).all()) {
    models.add(row.model);
  }
  return [...models].sort((left, right) => left.localeCompare(right));
}

export function upsertModelRate(
  database: AppDatabase,
  rate: Omit<ModelRate, "updatedAt">,
): ModelRate {
  const updatedAt = Date.now();
  database
    .insert(modelRates)
    .values({ ...rate, updatedAt })
    .onConflictDoUpdate({
      target: modelRates.model,
      set: {
        cachedInputRate: rate.cachedInputRate,
        inputRate: rate.inputRate,
        outputRate: rate.outputRate,
        updatedAt,
      },
    })
    .run();

  return { ...rate, updatedAt: new Date(updatedAt).toISOString() };
}

export function backfillUnpricedUsage(database: AppDatabase, model: string): number {
  const rate = database.select().from(modelRates).where(eq(modelRates.model, model)).get();
  if (!rate) return 0;

  return database.transaction((transaction) => {
    const rawResult = transaction
      .update(usageEvents)
      .set({
        cachedInputRate: rate.cachedInputRate,
        costUsd: sql<number>`((${usageEvents.inputTokens} - ${usageEvents.cachedInputTokens}) * ${rate.inputRate} + ${usageEvents.cachedInputTokens} * ${rate.cachedInputRate} + ${usageEvents.outputTokens} * ${rate.outputRate}) / 1000000.0`,
        inputRate: rate.inputRate,
        outputRate: rate.outputRate,
      })
      .where(and(eq(usageEvents.model, model), isNull(usageEvents.costUsd)))
      .run();
    const dailyResult = transaction.run(sql`
    update ${usageDailyRollups}
    set
      cost_usd = cost_usd + ((unpriced_input_tokens - unpriced_cached_input_tokens) * ${rate.inputRate} + unpriced_cached_input_tokens * ${rate.cachedInputRate} + unpriced_output_tokens * ${rate.outputRate}) / 1000000.0,
      unpriced_usage_count = 0,
      unpriced_input_tokens = 0,
      unpriced_cached_input_tokens = 0,
      unpriced_output_tokens = 0
    where model = ${model} and unpriced_usage_count > 0
  `);
    const hourlyResult = transaction.run(sql`
    update ${usageHourlyRollups}
    set
      cost_usd = cost_usd + ((unpriced_input_tokens - unpriced_cached_input_tokens) * ${rate.inputRate} + unpriced_cached_input_tokens * ${rate.cachedInputRate} + unpriced_output_tokens * ${rate.outputRate}) / 1000000.0,
      unpriced_usage_count = 0,
      unpriced_input_tokens = 0,
      unpriced_cached_input_tokens = 0,
      unpriced_output_tokens = 0
    where model = ${model} and unpriced_usage_count > 0
  `);
    const agentDailyResult = transaction.run(sql`
    update ${usageAgentDailyRollups}
    set
      cost_usd = cost_usd + ((unpriced_input_tokens - unpriced_cached_input_tokens) * ${rate.inputRate} + unpriced_cached_input_tokens * ${rate.cachedInputRate} + unpriced_output_tokens * ${rate.outputRate}) / 1000000.0,
      unpriced_usage_count = 0,
      unpriced_input_tokens = 0,
      unpriced_cached_input_tokens = 0,
      unpriced_output_tokens = 0
    where model = ${model} and unpriced_usage_count > 0
  `);
    const turnResult = transaction.run(sql`
    update ${turnModelUsage}
    set
      cost_usd = cost_usd + ((unpriced_input_tokens - unpriced_cached_input_tokens) * ${rate.inputRate} + unpriced_cached_input_tokens * ${rate.cachedInputRate} + unpriced_output_tokens * ${rate.outputRate}) / 1000000.0,
      unpriced_usage_count = 0,
      unpriced_input_tokens = 0,
      unpriced_cached_input_tokens = 0,
      unpriced_output_tokens = 0
    where model = ${model} and unpriced_usage_count > 0
  `);
    return (
      rawResult.changes +
      dailyResult.changes +
      hourlyResult.changes +
      agentDailyResult.changes +
      turnResult.changes
    );
  });
}

export function backfillAllUnpricedUsage(
  database: AppDatabase,
  onModelCommitted: (updated: number, model: string) => void = () => undefined,
): number {
  let total = 0;
  for (const rate of database
    .select({ model: modelRates.model })
    .from(modelRates)
    .orderBy(modelRates.model)
    .all()) {
    const updated = backfillUnpricedUsage(database, rate.model);
    total += updated;
    if (updated > 0) onModelCommitted(updated, rate.model);
  }
  return total;
}

export function reconcileUnknownModels(database: AppDatabase): number {
  return database.$client.transaction(() => {
    const affected = database.$client
      .prepare(
        `select
          unknown_event.id as id,
          (
            select known_event.model
            from usage_events as known_event
            where known_event.session_id = unknown_event.session_id
              and known_event.agent_id = unknown_event.agent_id
              and known_event.model != 'unknown'
            order by
              case
                when unknown_event.turn_key is not null
                  and known_event.turn_key = unknown_event.turn_key then 0
                else 1
              end,
              abs(julianday(known_event.timestamp) - julianday(unknown_event.timestamp)),
              known_event.timestamp,
              known_event.id
            limit 1
          ) as targetModel
        from usage_events as unknown_event
        where unknown_event.model = 'unknown'
          and exists (
            select 1 from usage_events as known_event
            where known_event.session_id = unknown_event.session_id
              and known_event.agent_id = unknown_event.agent_id
              and known_event.model != 'unknown'
          )`,
      )
      .all() as { id: string; targetModel: string }[];
    if (affected.length === 0) return 0;

    const result = database.run(sql`
      update ${usageEvents} as unknown_event
      set model = (
        select known_event.model
        from ${usageEvents} as known_event
        where known_event.session_id = unknown_event.session_id
          and known_event.agent_id = unknown_event.agent_id
          and known_event.model != 'unknown'
        order by
          case
            when unknown_event.turn_key is not null
              and known_event.turn_key = unknown_event.turn_key then 0
            else 1
          end,
          abs(julianday(known_event.timestamp) - julianday(unknown_event.timestamp)),
          known_event.timestamp,
          known_event.id
        limit 1
      )
      where unknown_event.model = 'unknown'
        and exists (
          select 1
          from ${usageEvents} as known_event
          where known_event.session_id = unknown_event.session_id
            and known_event.agent_id = unknown_event.agent_id
            and known_event.model != 'unknown'
        )
    `);
    for (const value of affected) {
      const event = database.select().from(usageEvents).where(eq(usageEvents.id, value.id)).get();
      if (event) moveAttributedUsageModel(database, { ...event, targetModel: value.targetModel });
    }
    return result.changes;
  })();
}

type ReclassifiedUsageRow = typeof usageEvents.$inferSelect & { targetModel: string };

function moveAttributedUsageModel(database: AppDatabase, event: ReclassifiedUsageRow) {
  if (
    !event.turnKey ||
    event.turnAttributionVersion !== TURN_ATTRIBUTION_VERSION ||
    event.targetModel === "unknown"
  ) {
    return;
  }
  const unpriced = event.costUsd === null;
  database
    .update(turnModelUsage)
    .set({
      cachedInputTokens: sql`${turnModelUsage.cachedInputTokens} - ${event.cachedInputTokens}`,
      costUsd: sql`${turnModelUsage.costUsd} - ${event.costUsd ?? 0}`,
      inputTokens: sql`${turnModelUsage.inputTokens} - ${event.inputTokens}`,
      outputTokens: sql`${turnModelUsage.outputTokens} - ${event.outputTokens}`,
      reasoningOutputTokens: sql`${turnModelUsage.reasoningOutputTokens} - ${event.reasoningOutputTokens}`,
      requestCount: sql`${turnModelUsage.requestCount} - 1`,
      totalTokens: sql`${turnModelUsage.totalTokens} - ${event.totalTokens}`,
      unpricedCachedInputTokens: sql`${turnModelUsage.unpricedCachedInputTokens} - ${unpriced ? event.cachedInputTokens : 0}`,
      unpricedInputTokens: sql`${turnModelUsage.unpricedInputTokens} - ${unpriced ? event.inputTokens : 0}`,
      unpricedOutputTokens: sql`${turnModelUsage.unpricedOutputTokens} - ${unpriced ? event.outputTokens : 0}`,
      unpricedUsageCount: sql`${turnModelUsage.unpricedUsageCount} - ${unpriced ? 1 : 0}`,
    })
    .where(and(eq(turnModelUsage.turnKey, event.turnKey), eq(turnModelUsage.model, "unknown")))
    .run();
  database
    .delete(turnModelUsage)
    .where(
      and(
        eq(turnModelUsage.turnKey, event.turnKey),
        eq(turnModelUsage.model, "unknown"),
        sql`${turnModelUsage.requestCount} <= 0`,
      ),
    )
    .run();
  database
    .insert(turnModelUsage)
    .values({
      cachedInputTokens: event.cachedInputTokens,
      costAttributionMissingCount: 0,
      costUsd: event.costUsd ?? 0,
      inputTokens: event.inputTokens,
      model: event.targetModel,
      outputTokens: event.outputTokens,
      reasoningOutputTokens: event.reasoningOutputTokens,
      requestCount: 1,
      totalTokens: event.totalTokens,
      turnKey: event.turnKey,
      unpricedCachedInputTokens: unpriced ? event.cachedInputTokens : 0,
      unpricedInputTokens: unpriced ? event.inputTokens : 0,
      unpricedOutputTokens: unpriced ? event.outputTokens : 0,
      unpricedUsageCount: unpriced ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [turnModelUsage.turnKey, turnModelUsage.model],
      set: {
        cachedInputTokens: sql`${turnModelUsage.cachedInputTokens} + ${event.cachedInputTokens}`,
        costUsd: sql`${turnModelUsage.costUsd} + ${event.costUsd ?? 0}`,
        inputTokens: sql`${turnModelUsage.inputTokens} + ${event.inputTokens}`,
        outputTokens: sql`${turnModelUsage.outputTokens} + ${event.outputTokens}`,
        reasoningOutputTokens: sql`${turnModelUsage.reasoningOutputTokens} + ${event.reasoningOutputTokens}`,
        requestCount: sql`${turnModelUsage.requestCount} + 1`,
        totalTokens: sql`${turnModelUsage.totalTokens} + ${event.totalTokens}`,
        unpricedCachedInputTokens: sql`${turnModelUsage.unpricedCachedInputTokens} + ${unpriced ? event.cachedInputTokens : 0}`,
        unpricedInputTokens: sql`${turnModelUsage.unpricedInputTokens} + ${unpriced ? event.inputTokens : 0}`,
        unpricedOutputTokens: sql`${turnModelUsage.unpricedOutputTokens} + ${unpriced ? event.outputTokens : 0}`,
        unpricedUsageCount: sql`${turnModelUsage.unpricedUsageCount} + ${unpriced ? 1 : 0}`,
      },
    })
    .run();
}

const rawAggregateFields = {
  cachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)`,
  estimatedCostUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)`,
  inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
  requestCount: sql<number>`count(${usageEvents.id})`,
  reasoningOutputTokens: sql<number>`coalesce(sum(${usageEvents.reasoningOutputTokens}), 0)`,
  totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)`,
  unpricedUsageCount: sql<number>`coalesce(sum(case when ${usageEvents.costUsd} is null then 1 else 0 end), 0)`,
};

const aggregateFields = {
  ...rawAggregateFields,
  sessionCount: sql<number>`count(distinct ${usageEvents.sessionId})`,
};

const dailyRollupAggregateFields = {
  cachedInputTokens: sql<number>`coalesce(sum(${usageDailyRollups.cachedInputTokens}), 0)`,
  estimatedCostUsd: sql<number>`coalesce(sum(${usageDailyRollups.costUsd}), 0)`,
  inputTokens: sql<number>`coalesce(sum(${usageDailyRollups.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${usageDailyRollups.outputTokens}), 0)`,
  reasoningOutputTokens: sql<number>`coalesce(sum(${usageDailyRollups.reasoningOutputTokens}), 0)`,
  requestCount: sql<number>`coalesce(sum(${usageDailyRollups.requestCount}), 0)`,
  totalTokens: sql<number>`coalesce(sum(${usageDailyRollups.totalTokens}), 0)`,
  unpricedUsageCount: sql<number>`coalesce(sum(${usageDailyRollups.unpricedUsageCount}), 0)`,
};

const hourlyRollupAggregateFields = {
  cachedInputTokens: sql<number>`coalesce(sum(${usageHourlyRollups.cachedInputTokens}), 0)`,
  estimatedCostUsd: sql<number>`coalesce(sum(${usageHourlyRollups.costUsd}), 0)`,
  inputTokens: sql<number>`coalesce(sum(${usageHourlyRollups.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${usageHourlyRollups.outputTokens}), 0)`,
  reasoningOutputTokens: sql<number>`coalesce(sum(${usageHourlyRollups.reasoningOutputTokens}), 0)`,
  requestCount: sql<number>`coalesce(sum(${usageHourlyRollups.requestCount}), 0)`,
  totalTokens: sql<number>`coalesce(sum(${usageHourlyRollups.totalTokens}), 0)`,
  unpricedUsageCount: sql<number>`coalesce(sum(${usageHourlyRollups.unpricedUsageCount}), 0)`,
};

function usageWhere(filters: DashboardFilters) {
  const conditions = [
    gte(usageEvents.localDate, filters.from),
    lte(usageEvents.localDate, filters.to),
  ];
  const models = selectedModels(filters);
  if (models.length === 1) conditions.push(eq(usageEvents.model, models[0]!));
  if (models.length > 1) conditions.push(inArray(usageEvents.model, models));
  if (filters.agentKind && filters.agentKind !== "all") {
    conditions.push(sql`exists (
      select 1 from ${sessionAgents}
      where ${sessionAgents.id} = ${usageEvents.agentId}
        and ${sessionAgents.threadSource} ${
          filters.agentKind === "subagent" ? sql`= 'subagent'` : sql`!= 'subagent'`
        }
    )`);
  }
  if (filters.projectId) {
    conditions.push(sql`exists (
      select 1 from ${sessions}
      where ${sessions.id} = ${usageEvents.sessionId}
        and ${sessions.projectId} = ${filters.projectId}
    )`);
  }
  if (filters.tagIds?.length) {
    conditions.push(sql`exists (
      select 1 from ${sessions}
      join ${projectTags} on ${projectTags.projectId} = ${sessions.projectId}
      where ${sessions.id} = ${usageEvents.sessionId}
        and ${inArray(projectTags.tagId, filters.tagIds)}
    )`);
  }
  return and(...conditions);
}

function dailyRollupWhere(filters: DashboardFilters) {
  const conditions = [
    gte(usageDailyRollups.localDate, filters.from),
    lte(usageDailyRollups.localDate, filters.to),
  ];
  const models = selectedModels(filters);
  if (models.length === 1) conditions.push(eq(usageDailyRollups.model, models[0]!));
  if (models.length > 1) conditions.push(inArray(usageDailyRollups.model, models));
  if (filters.agentKind && filters.agentKind !== "all")
    conditions.push(eq(usageDailyRollups.agentKind, filters.agentKind));
  if (filters.projectId) conditions.push(eq(usageDailyRollups.projectId, filters.projectId));
  if (filters.tagIds?.length) {
    conditions.push(sql`exists (
      select 1 from ${projectTags}
      where ${projectTags.projectId} = ${usageDailyRollups.projectId}
        and ${inArray(projectTags.tagId, filters.tagIds)}
    )`);
  }
  return and(...conditions);
}

function hourlyRollupWhere(filters: DashboardFilters) {
  const conditions = [
    gte(usageHourlyRollups.localDate, filters.from),
    lte(usageHourlyRollups.localDate, filters.to),
  ];
  const models = selectedModels(filters);
  if (models.length === 1) conditions.push(eq(usageHourlyRollups.model, models[0]!));
  if (models.length > 1) conditions.push(inArray(usageHourlyRollups.model, models));
  if (filters.agentKind && filters.agentKind !== "all")
    conditions.push(eq(usageHourlyRollups.agentKind, filters.agentKind));
  if (filters.projectId) conditions.push(eq(usageHourlyRollups.projectId, filters.projectId));
  if (filters.tagIds?.length) {
    conditions.push(sql`exists (
      select 1 from ${projectTags}
      where ${projectTags.projectId} = ${usageHourlyRollups.projectId}
        and ${inArray(projectTags.tagId, filters.tagIds)}
    )`);
  }
  return and(...conditions);
}

function membershipWhere(filters: DashboardFilters, bucketType: "day" | "hour") {
  const from = bucketType === "day" ? filters.from : `${filters.from}T00:00`;
  const to = bucketType === "day" ? filters.to : `${filters.to}T23:59`;
  const conditions = [
    eq(usageRollupSessionMemberships.bucketType, bucketType),
    gte(usageRollupSessionMemberships.bucketStart, from),
    lte(usageRollupSessionMemberships.bucketStart, to),
  ];
  const models = selectedModels(filters);
  if (models.length === 1) conditions.push(eq(usageRollupSessionMemberships.model, models[0]!));
  if (models.length > 1) conditions.push(inArray(usageRollupSessionMemberships.model, models));
  if (filters.agentKind && filters.agentKind !== "all")
    conditions.push(eq(usageRollupSessionMemberships.agentKind, filters.agentKind));
  if (filters.projectId)
    conditions.push(eq(usageRollupSessionMemberships.projectId, filters.projectId));
  if (filters.tagIds?.length) {
    conditions.push(sql`exists (
      select 1 from ${projectTags}
      where ${projectTags.projectId} = ${usageRollupSessionMemberships.projectId}
        and ${inArray(projectTags.tagId, filters.tagIds)}
    )`);
  }
  return and(...conditions);
}

function selectedModels(filters: DashboardFilters): string[] {
  if (filters.models && filters.models.length > 0) return [...new Set(filters.models)];
  return filters.model ? [filters.model] : [];
}

type AggregateRow = {
  [Key in keyof typeof aggregateFields]: number | string | null;
};

type UsageAggregateRow = {
  [Key in keyof typeof rawAggregateFields]: number | string | null;
};

function toUsageValues(row: UsageAggregateRow): UsageValues {
  return {
    cachedInputTokens: toNumber(row.cachedInputTokens),
    estimatedCostUsd: toNumber(row.estimatedCostUsd),
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    reasoningOutputTokens: toNumber(row.reasoningOutputTokens),
    requestCount: toNumber(row.requestCount),
    totalTokens: toNumber(row.totalTokens),
    unpricedUsageCount: toNumber(row.unpricedUsageCount),
  };
}

function toKpis(row: AggregateRow | undefined): DashboardKpis {
  return {
    cachedInputTokens: toNumber(row?.cachedInputTokens),
    estimatedCostUsd: toNumber(row?.estimatedCostUsd),
    inputTokens: toNumber(row?.inputTokens),
    outputTokens: toNumber(row?.outputTokens),
    reasoningOutputTokens: toNumber(row?.reasoningOutputTokens),
    requestCount: toNumber(row?.requestCount),
    sessionCount: toNumber(row?.sessionCount),
    totalTokens: toNumber(row?.totalTokens),
    unpricedUsageCount: toNumber(row?.unpricedUsageCount),
  };
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

function localMinuteOfDay(now: Date): number {
  const parts = Object.fromEntries(
    LOCAL_TIME_FORMATTER.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return Number(parts["hour"]) * 60 + Number(parts["minute"]);
}

function minuteLabel(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function toNumber(value: number | string | null | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
