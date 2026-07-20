import { asc, eq, sql } from "drizzle-orm";

import { getSessions } from "@/server/analytics";
import type { AppDatabase } from "@/server/db/client";
import {
  activityEvents,
  sessionAgents,
  turnActivityRollups,
  turnModelUsage,
  usageEvents,
} from "@/server/db/schema";
import { getRetentionCoverage } from "@/server/retention";
import type {
  ActivityKind,
  ActivityTimelineItem,
  TurnActivityCount,
  TurnBackfillStatus,
  TurnComparisonResponse,
  TurnContextBucket,
  TurnCostCoverage,
  TurnCoverage,
  TurnDiagnosticBaseline,
  TurnDiagnosticItem,
  TurnDiagnosticMetric,
  TurnDiagnosticReason,
  TurnDiagnosticsResponse,
  TurnDailyUsage,
  TurnDetailResponse,
  TurnFilters,
  TurnKpis,
  TurnModelUsage,
  TurnPressureFilter,
  TurnRequestUsage,
  TurnSummary,
  TurnUsageMetrics,
  TurnsResponse,
} from "@/shared/types";

const TIMELINE_LIMIT = 2_000;
const DIAGNOSTIC_MAX_DAYS = 90;
const DIAGNOSTIC_MAX_MATCHED_TURNS = 20_000;
const DIAGNOSTIC_MAX_ITEMS = 50;
const DIAGNOSTIC_MINIMUM_SAMPLE = 20;

export class TurnDiagnosticsLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnDiagnosticsLimitError";
  }
}

type AggregateRow = {
  agentId: string;
  agentKind: string;
  agentName: string | null;
  cachedInputTokens: number;
  collaborationMode: string | null;
  completedAt: string | null;
  costAttributionMissingCount: number;
  costUsd: number;
  depth: number;
  durationMs: number | null;
  effort: string | null;
  firstInputTokens: number | null;
  inputTokens: number;
  lastEventAt: string;
  lastInputTokens: number | null;
  modelContextWindow: number | null;
  models: string | null;
  ordinal: number;
  outputTokens: number;
  parentAgentId: string | null;
  peakInputTokens: number | null;
  projectId: string | null;
  reasoningOutputTokens: number;
  requestCount: number;
  role: string | null;
  sessionId: string;
  sessionTitle: string | null;
  startedAt: string | null;
  status: string;
  timeToFirstTokenMs: number | null;
  totalTokens: number;
  turnId: string;
  turnKey: string;
  unpricedUsageCount: number;
};

type FilterSql = { models: string[]; params: (number | string)[]; where: string };

export function getTurns(
  database: AppDatabase,
  filters: TurnFilters,
  backfill: TurnBackfillStatus,
  importerIsSyncing: boolean,
): TurnsResponse {
  const filterSql = buildFilters(filters);
  const pageData = readTurnPage(database, filters, filterSql);

  return {
    contextBuckets: getContextBuckets(database, filterSql),
    coverage: turnCoverage(filters, backfill),
    daily: getDaily(database, filterSql),
    kpis: getKpis(database, filterSql),
    liveRefreshSuggested: importerIsSyncing,
    ...pageData,
  };
}

export function getTurnPage(
  database: AppDatabase,
  filters: TurnFilters,
): Pick<TurnsResponse, "page" | "pageSize" | "total" | "turns"> {
  return readTurnPage(database, filters, buildFilters(filters));
}

export function getTurnDiagnostics(
  database: AppDatabase,
  filters: TurnFilters,
  backfill: TurnBackfillStatus,
): TurnDiagnosticsResponse {
  if (inclusiveDayCount(filters.from, filters.to) > DIAGNOSTIC_MAX_DAYS) {
    throw new TurnDiagnosticsLimitError(
      "Turn diagnostics supports at most 90 days; narrow the date range",
    );
  }
  const filterSql = buildFilters(filters);
  const totalRow = database.$client
    .prepare(`${baseCountSql()} where ${filterSql.where}`)
    .get(...filterSql.params) as { total: number } | undefined;
  const matchedTurnCount = Number(totalRow?.total ?? 0);
  if (matchedTurnCount > DIAGNOSTIC_MAX_MATCHED_TURNS) {
    throw new TurnDiagnosticsLimitError(
      "Turn diagnostics matched more than 20,000 turns; narrow the filters",
    );
  }
  const rows = database.$client
    .prepare(`${baseSummarySql(filterSql.models)} where ${filterSql.where} order by t.id asc`)
    .all(...filterSql.models, ...filterSql.params) as AggregateRow[];
  const turns = rows.map(toSummary);
  const baselines = {
    cost: diagnosticBaseline(
      turns.flatMap((turn) => (turn.costCoverage === "exact" ? [turn.estimatedCostUsd] : [])),
      turns.length,
    ),
    duration: diagnosticBaseline(
      turns.flatMap((turn) => (turn.durationMs === null ? [] : [turn.durationMs])),
      turns.length,
    ),
    ttft: diagnosticBaseline(
      turns.flatMap((turn) => (turn.timeToFirstTokenMs === null ? [] : [turn.timeToFirstTokenMs])),
      turns.length,
    ),
  } satisfies Record<TurnDiagnosticMetric, TurnDiagnosticBaseline>;
  let outlierTurnCount = 0;
  const candidates = turns.flatMap((turn) => {
    const reasons: TurnDiagnosticReason[] = [];
    if (diagnosticOutlier(turn.durationMs, baselines.duration)) reasons.push("duration-p95");
    if (diagnosticOutlier(turn.timeToFirstTokenMs, baselines.ttft)) reasons.push("ttft-p95");
    if (turn.costCoverage === "exact") {
      if (diagnosticOutlier(turn.estimatedCostUsd, baselines.cost)) reasons.push("cost-p95");
    } else reasons.push(turn.costCoverage === "partial" ? "cost-partial" : "cost-unavailable");
    const contextReason = diagnosticContextReason(turn.contextUtilizationPercent);
    if (contextReason) reasons.push(contextReason);
    if (reasons.length === 0) return [];
    if (reasons.some((reason) => reason !== "cost-partial" && reason !== "cost-unavailable")) {
      outlierTurnCount += 1;
    }
    return [
      {
        contextSeverity: diagnosticContextSeverity(turn.contextUtilizationPercent),
        item: { reasons, turn } satisfies TurnDiagnosticItem,
        p95Ratio: Math.max(
          diagnosticP95Ratio(turn.durationMs, baselines.duration),
          diagnosticP95Ratio(turn.timeToFirstTokenMs, baselines.ttft),
          turn.costCoverage === "exact"
            ? diagnosticP95Ratio(turn.estimatedCostUsd, baselines.cost)
            : 0,
        ),
      },
    ];
  });
  candidates.sort(
    (left, right) =>
      right.contextSeverity - left.contextSeverity ||
      right.p95Ratio - left.p95Ratio ||
      left.item.turn.turnKey.localeCompare(right.item.turn.turnKey),
  );
  return {
    baselines,
    coverage: turnCoverage(filters, backfill),
    items: candidates.slice(0, DIAGNOSTIC_MAX_ITEMS).map((candidate) => candidate.item),
    matchedTurnCount,
    outlierTurnCount,
  };
}

function readTurnPage(
  database: AppDatabase,
  filters: TurnFilters,
  filterSql: FilterSql,
): Pick<TurnsResponse, "page" | "pageSize" | "total" | "turns"> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const totalRow = database.$client
    .prepare(`${baseCountSql()} where ${filterSql.where}`)
    .get(...filterSql.params) as { total: number } | undefined;
  const total = Number(totalRow?.total ?? 0);
  const orderBy = sortSql(filters.sort ?? "lastActivity", filters.order ?? "desc");
  const rows = database.$client
    .prepare(
      `${baseSummarySql(filterSql.models)} where ${filterSql.where} order by ${orderBy}, t.id asc limit ? offset ?`,
    )
    .all(
      ...filterSql.models,
      ...filterSql.params,
      pageSize,
      (page - 1) * pageSize,
    ) as AggregateRow[];
  return {
    page,
    pageSize,
    total,
    turns: rows.map(toSummary),
  };
}

export function getTurnDetail(database: AppDatabase, turnKey: string): TurnDetailResponse | null {
  const rows = database.$client
    .prepare(`${baseSummarySql()} where t.id = ?`)
    .all(turnKey) as AggregateRow[];
  const turn = rows[0] ? toSummary(rows[0]) : null;
  if (!turn) return null;

  const modelRows = database
    .select()
    .from(turnModelUsage)
    .where(eq(turnModelUsage.turnKey, turnKey))
    .orderBy(asc(turnModelUsage.model))
    .all();
  const models = modelRows.map(toModelUsage);
  const activity = database
    .select({ count: turnActivityRollups.eventCount, kind: turnActivityRollups.kind })
    .from(turnActivityRollups)
    .where(eq(turnActivityRollups.turnKey, turnKey))
    .orderBy(asc(turnActivityRollups.kind))
    .all()
    .map((row): TurnActivityCount => ({ count: row.count, kind: row.kind as ActivityKind }));
  const requestRows = database
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.turnKey, turnKey))
    .orderBy(asc(usageEvents.timestamp))
    .limit(TIMELINE_LIMIT + 1)
    .all();
  const requests = requestRows.slice(0, TIMELINE_LIMIT).map((row): TurnRequestUsage => ({
    cachedInputTokens: row.cachedInputTokens,
    contextUtilizationPercent: contextPercent(row.inputTokens, turn.contextWindowTokens),
    costCoverage: row.costUsd === null ? "unavailable" : "exact",
    estimatedCostUsd: row.costUsd,
    id: row.id,
    inputTokens: row.inputTokens,
    model: row.model,
    outputTokens: row.outputTokens,
    reasoningOutputTokens: row.reasoningOutputTokens,
    timestamp: row.timestamp,
    totalTokens: row.totalTokens,
  }));
  const activityTimeline = readActivityTimeline(database, turnKey);
  const rawRequestCount = Number(
    database
      .select({ count: sql<number>`count(*)` })
      .from(usageEvents)
      .where(eq(usageEvents.turnKey, turnKey))
      .get()?.count ?? 0,
  );
  const rawActivityCount = Number(
    database
      .select({ count: sql<number>`count(*)` })
      .from(activityEvents)
      .where(eq(activityEvents.turnKey, turnKey))
      .get()?.count ?? 0,
  );
  const aggregateActivityCount = activity.reduce((total, item) => total + item.count, 0);
  const rawItemCount = rawRequestCount + rawActivityCount;
  const aggregateItemCount = turn.requestCount + aggregateActivityCount;
  const timelineCoverage =
    rawItemCount === aggregateItemCount
      ? {
          from: (turn.startedAt ?? turn.lastEventAt).slice(0, 10),
          status: "full" as const,
          to: turn.lastEventAt.slice(0, 10),
        }
      : rawItemCount === 0
        ? { from: null, status: "none" as const, to: null }
        : {
            from: getRetentionCoverage({
              from: turn.startedAt?.slice(0, 10) ?? "0000-01-01",
              to: turn.lastEventAt.slice(0, 10),
            }).rawFrom,
            status: "partial" as const,
            to: turn.lastEventAt.slice(0, 10),
          };
  const session = getSessions(database, {
    from: "0000-01-01",
    page: 1,
    pageSize: 1,
    query: turn.sessionId,
    to: "9999-12-31",
  }).sessions.find((item) => item.sessionId === turn.sessionId);

  return {
    activity,
    activityTimeline: activityTimeline.items,
    models,
    requests,
    threadAgents: session?.agents ?? [],
    timelineCoverage,
    timelineTruncated: requestRows.length > TIMELINE_LIMIT || activityTimeline.truncated,
    turn,
  };
}

export function compareTurns(database: AppDatabase, ids: string[]): TurnComparisonResponse {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { missingIds: [], turns: [] };
  const placeholders = unique.map(() => "?").join(", ");
  const rows = database.$client
    .prepare(`${baseSummarySql()} where t.id in (${placeholders})`)
    .all(...unique) as AggregateRow[];
  const byId = new Map(rows.map((row) => [row.turnKey, toSummary(row)]));
  return {
    missingIds: unique.filter((id) => !byId.has(id)),
    turns: unique.flatMap((id) => {
      const value = byId.get(id);
      return value ? [value] : [];
    }),
  };
}

function buildFilters(filters: TurnFilters): FilterSql {
  const conditions = ["t.local_date >= ?", "t.local_date <= ?"];
  const params: (number | string)[] = [filters.from, filters.to];
  if (filters.projectId) {
    conditions.push("t.project_id = ?");
    params.push(filters.projectId);
  }
  if (filters.tagIds?.length) {
    conditions.push(
      `exists (
        select 1 from project_tags tag_filter
        where tag_filter.project_id = t.project_id
          and tag_filter.tag_id in (${filters.tagIds.map(() => "?").join(", ")})
      )`,
    );
    params.push(...filters.tagIds);
  }
  if (filters.agentKind && filters.agentKind !== "all") {
    conditions.push(
      filters.agentKind === "subagent"
        ? "a.thread_source = 'subagent'"
        : "a.thread_source != 'subagent'",
    );
  }
  if (filters.sessionId) {
    conditions.push("t.session_id = ?");
    params.push(filters.sessionId);
  }
  if (filters.agentId) {
    conditions.push("t.agent_id = ?");
    params.push(filters.agentId);
  }
  if (filters.status) {
    conditions.push("t.status = ?");
    params.push(filters.status);
  }
  if (filters.effort) {
    conditions.push("t.effort = ?");
    params.push(filters.effort);
  }
  if (filters.pressure) {
    addPressureCondition(conditions, params, filters.pressure);
  }
  const models = filters.models?.length ? filters.models : filters.model ? [filters.model] : [];
  if (models.length > 0) {
    conditions.push(
      `exists (select 1 from turn_model_usage fm where fm.turn_key = t.id and fm.model in (${models.map(() => "?").join(", ")}))`,
    );
    params.push(...models);
  }
  if (filters.query) {
    conditions.push(
      "(s.title like ? escape '\\' or s.id like ? escape '\\' or t.turn_id like ? escape '\\' or coalesce(a.name, '') like ? escape '\\' or coalesce(a.role, '') like ? escape '\\')",
    );
    const value = `%${escapeLike(filters.query)}%`;
    params.push(value, value, value, value, value);
  }
  return { models, params, where: conditions.join(" and ") };
}

function baseCountSql(): string {
  return `select count(*) as total
    from turns t
    join sessions s on s.id = t.session_id
    join session_agents a on a.id = t.agent_id`;
}

function usageSubquery(models: string[] = []): string {
  const where = models.length > 0 ? `where model in (${models.map(() => "?").join(", ")})` : "";
  return `(select
      turn_key,
      group_concat(model) as models,
      sum(input_tokens) as input_tokens,
      sum(cached_input_tokens) as cached_input_tokens,
      sum(output_tokens) as output_tokens,
      sum(reasoning_output_tokens) as reasoning_output_tokens,
      sum(total_tokens) as total_tokens,
      sum(request_count) as request_count,
      sum(cost_usd) as cost_usd,
      sum(unpriced_usage_count) as unpriced_usage_count,
      sum(cost_attribution_missing_count) as cost_attribution_missing_count
    from turn_model_usage ${where} group by turn_key)`;
}

function baseSummarySql(models: string[] = []): string {
  return `with ranked_turns as (
      select t0.*,
        row_number() over (
          partition by t0.agent_id
          order by coalesce(t0.started_at, t0.last_event_at), t0.turn_id
        ) as ordinal
      from turns t0
    )
    select
      t.id as turnKey,
      t.turn_id as turnId,
      t.session_id as sessionId,
      t.agent_id as agentId,
      t.project_id as projectId,
      t.started_at as startedAt,
      t.completed_at as completedAt,
      t.last_event_at as lastEventAt,
      t.status as status,
      t.effort as effort,
      t.collaboration_mode as collaborationMode,
      t.model_context_window as modelContextWindow,
      t.duration_ms as durationMs,
      t.time_to_first_token_ms as timeToFirstTokenMs,
      t.first_input_tokens as firstInputTokens,
      t.last_input_tokens as lastInputTokens,
      t.peak_input_tokens as peakInputTokens,
      t.ordinal as ordinal,
      s.title as sessionTitle,
      a.name as agentName,
      a.role as role,
      a.depth as depth,
      a.parent_thread_id as parentAgentId,
      case when a.thread_source = 'subagent' then 'subagent' else 'main' end as agentKind,
      coalesce(u.models, '') as models,
      coalesce(u.input_tokens, 0) as inputTokens,
      coalesce(u.cached_input_tokens, 0) as cachedInputTokens,
      coalesce(u.output_tokens, 0) as outputTokens,
      coalesce(u.reasoning_output_tokens, 0) as reasoningOutputTokens,
      coalesce(u.total_tokens, 0) as totalTokens,
      coalesce(u.request_count, 0) as requestCount,
      coalesce(u.cost_usd, 0) as costUsd,
      coalesce(u.unpriced_usage_count, 0) as unpricedUsageCount,
      coalesce(u.cost_attribution_missing_count, 0) as costAttributionMissingCount
    from ranked_turns t
    join sessions s on s.id = t.session_id
    join session_agents a on a.id = t.agent_id
    left join ${usageSubquery(models)} u on u.turn_key = t.id`;
}

function getKpis(database: AppDatabase, filters: FilterSql): TurnKpis {
  const row = database.$client
    .prepare(
      `select
        count(*) as turnCount,
        coalesce(sum(u.total_tokens), 0) as totalTokens,
        coalesce(sum(u.input_tokens), 0) as inputTokens,
        coalesce(sum(u.cached_input_tokens), 0) as cachedInputTokens,
        coalesce(sum(u.cost_usd), 0) as costUsd,
        coalesce(sum(u.request_count), 0) as requestCount,
        coalesce(sum(u.unpriced_usage_count + u.cost_attribution_missing_count), 0) as unknownCostCount,
        sum(case when t.model_context_window > 0 and t.peak_input_tokens * 100.0 / t.model_context_window >= 70 then 1 else 0 end) as pressureCount
      from turns t
      join sessions s on s.id = t.session_id
      join session_agents a on a.id = t.agent_id
      left join ${usageSubquery(filters.models)} u on u.turn_key = t.id
      where ${filters.where}`,
    )
    .get(...filters.models, ...filters.params) as
    | {
        cachedInputTokens: number;
        costUsd: number;
        inputTokens: number;
        pressureCount: number;
        requestCount: number;
        totalTokens: number;
        turnCount: number;
        unknownCostCount: number;
      }
    | undefined;
  const turnCount = Number(row?.turnCount ?? 0);
  const requestCount = Number(row?.requestCount ?? 0);
  const unknownCostCount = Number(row?.unknownCostCount ?? 0);
  const costCoverage = coverage(requestCount, unknownCostCount);
  const cost = Number(row?.costUsd ?? 0);
  const input = Number(row?.inputTokens ?? 0);
  const cached = Number(row?.cachedInputTokens ?? 0);
  return {
    averageCostPerTurn: costCoverage === "exact" && turnCount > 0 ? cost / turnCount : null,
    cacheRate: input > 0 ? (cached / input) * 100 : 0,
    contextPressureTurnCount: Number(row?.pressureCount ?? 0),
    costCoverage,
    estimatedCostUsd: cost,
    p50DurationMs: readPercentile(database, filters, "duration_ms", 0.5),
    p50TimeToFirstTokenMs: readPercentile(database, filters, "time_to_first_token_ms", 0.5),
    p95DurationMs: readPercentile(database, filters, "duration_ms", 0.95),
    totalTokens: Number(row?.totalTokens ?? 0),
    turnCount,
  };
}

function getDaily(database: AppDatabase, filters: FilterSql): TurnDailyUsage[] {
  const rows = database.$client
    .prepare(
      `select
        t.local_date as date,
        count(*) as turnCount,
        coalesce(sum(u.total_tokens), 0) as totalTokens,
        coalesce(sum(u.cost_usd), 0) as estimatedCostUsd,
        coalesce(sum(u.request_count), 0) as requestCount,
        coalesce(sum(u.unpriced_usage_count + u.cost_attribution_missing_count), 0) as unknownCostCount
      from turns t
      join sessions s on s.id = t.session_id
      join session_agents a on a.id = t.agent_id
      left join ${usageSubquery(filters.models)} u on u.turn_key = t.id
      where ${filters.where}
      group by t.local_date order by t.local_date`,
    )
    .all(...filters.models, ...filters.params) as {
    date: string;
    estimatedCostUsd: number;
    requestCount: number;
    totalTokens: number;
    turnCount: number;
    unknownCostCount: number;
  }[];
  return rows.map((row) => ({
    costCoverage: coverage(Number(row.requestCount), Number(row.unknownCostCount)),
    date: row.date,
    estimatedCostUsd: Number(row.estimatedCostUsd),
    totalTokens: Number(row.totalTokens),
    turnCount: Number(row.turnCount),
  }));
}

function getContextBuckets(database: AppDatabase, filters: FilterSql): TurnContextBucket[] {
  const rows = database.$client
    .prepare(
      `select
        case
          when t.model_context_window is null or t.model_context_window <= 0 or t.peak_input_tokens is null then 'unknown'
          when t.peak_input_tokens * 100.0 / t.model_context_window >= 95 then '95+'
          when t.peak_input_tokens * 100.0 / t.model_context_window >= 85 then '85-94'
          when t.peak_input_tokens * 100.0 / t.model_context_window >= 70 then '70-84'
          else 'below-70'
        end as bucketId,
        count(*) as count
      from turns t
      join sessions s on s.id = t.session_id
      join session_agents a on a.id = t.agent_id
      where ${filters.where}
      group by bucketId`,
    )
    .all(...filters.params) as { bucketId: TurnContextBucket["id"]; count: number }[];
  const counts = new Map(rows.map((row) => [row.bucketId, Number(row.count)]));
  const buckets: { id: TurnContextBucket["id"]; label: string }[] = [
    { id: "below-70", label: "Bình thường · <70%" },
    { id: "70-84", label: "Cao · 70–84%" },
    { id: "85-94", label: "Rất cao · 85–94%" },
    { id: "95+", label: "Sắp đầy · ≥95%" },
    { id: "unknown", label: "Thiếu metadata" },
  ];
  return buckets.map((bucket): TurnContextBucket => ({
    ...bucket,
    count: counts.get(bucket.id) ?? 0,
  }));
}

function readActivityTimeline(
  database: AppDatabase,
  turnKey: string,
): { items: ActivityTimelineItem[]; truncated: boolean } {
  const rows = database
    .select({
      agentId: activityEvents.agentId,
      agentKind: activityEvents.agentKind,
      depth: sessionAgents.depth,
      id: activityEvents.id,
      kind: activityEvents.kind,
      name: sessionAgents.name,
      parentAgentId: sessionAgents.parentThreadId,
      projectId: activityEvents.projectId,
      role: sessionAgents.role,
      sessionId: activityEvents.sessionId,
      timestamp: activityEvents.timestamp,
      turnKey: activityEvents.turnKey,
    })
    .from(activityEvents)
    .leftJoin(sessionAgents, eq(sessionAgents.id, activityEvents.agentId))
    .where(eq(activityEvents.turnKey, turnKey))
    .orderBy(asc(activityEvents.timestamp))
    .limit(TIMELINE_LIMIT + 1)
    .all();
  return {
    items: rows.slice(0, TIMELINE_LIMIT).map((row) => ({
      agentId: row.agentId,
      agentKind: row.agentKind === "subagent" ? "subagent" : "main",
      depth: row.depth ?? 0,
      id: row.id,
      kind: row.kind as ActivityKind,
      name: row.name,
      parentAgentId: row.parentAgentId,
      projectId: row.projectId,
      role: row.role,
      sessionId: row.sessionId,
      timestamp: row.timestamp,
      turnKey: row.turnKey,
    })),
    truncated: rows.length > TIMELINE_LIMIT,
  };
}

function toSummary(row: AggregateRow): TurnSummary {
  const requestCount = Number(row.requestCount);
  const unknownCost = Number(row.unpricedUsageCount) + Number(row.costAttributionMissingCount);
  const input = Number(row.inputTokens);
  const cached = Number(row.cachedInputTokens);
  return {
    agentId: row.agentId,
    agentKind: row.agentKind === "subagent" ? "subagent" : "main",
    agentName: row.agentName,
    cacheRate: input > 0 ? (cached / input) * 100 : 0,
    cachedInputTokens: cached,
    collaborationMode: row.collaborationMode,
    completedAt: row.completedAt,
    contextUtilizationPercent: contextPercent(row.peakInputTokens, row.modelContextWindow),
    contextWindowTokens: row.modelContextWindow,
    costAttributionMissingCount: Number(row.costAttributionMissingCount),
    costCoverage: coverage(requestCount, unknownCost),
    depth: Number(row.depth),
    durationMs: row.durationMs,
    effort: row.effort,
    estimatedCostUsd: Number(row.costUsd),
    inputTokens: input,
    lastEventAt: row.lastEventAt,
    models: [...new Set((row.models ?? "").split(",").filter(Boolean))].sort(),
    ordinal: Number(row.ordinal),
    outputTokens: Number(row.outputTokens),
    parentAgentId: row.parentAgentId,
    peakInputTokens: row.peakInputTokens,
    projectId: row.projectId,
    reasoningOutputTokens: Number(row.reasoningOutputTokens),
    requestCount,
    role: row.role,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    startedAt: row.startedAt,
    status: row.status === "completed" || row.status === "aborted" ? row.status : "unknown",
    timeToFirstTokenMs: row.timeToFirstTokenMs,
    totalTokens: Number(row.totalTokens),
    turnId: row.turnId,
    turnKey: row.turnKey,
    unpricedUsageCount: Number(row.unpricedUsageCount),
  };
}

function toModelUsage(row: typeof turnModelUsage.$inferSelect): TurnModelUsage {
  const unknownCost = row.unpricedUsageCount + row.costAttributionMissingCount;
  const usage: TurnUsageMetrics = {
    cachedInputTokens: row.cachedInputTokens,
    costAttributionMissingCount: row.costAttributionMissingCount,
    costCoverage: coverage(row.requestCount, unknownCost),
    estimatedCostUsd: row.costUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningOutputTokens: row.reasoningOutputTokens,
    requestCount: row.requestCount,
    totalTokens: row.totalTokens,
    unpricedUsageCount: row.unpricedUsageCount,
  };
  return { ...usage, model: row.model };
}

function turnCoverage(filters: TurnFilters, backfill: TurnBackfillStatus): TurnCoverage {
  return {
    aggregate:
      backfill.isRunning || backfill.error !== null || backfill.sourceDeletedGaps > 0
        ? "partial"
        : "full",
    backfill,
    timeline: timelineCoverage(filters),
  };
}

function timelineCoverage(filters: TurnFilters) {
  const retention = getRetentionCoverage(filters);
  if (retention.sessionDetails === "none") return { from: null, status: "none" as const, to: null };
  return {
    from: filters.from < retention.rawFrom ? retention.rawFrom : filters.from,
    status: retention.sessionDetails,
    to: filters.to,
  };
}

function addPressureCondition(
  conditions: string[],
  params: (number | string)[],
  pressure: TurnPressureFilter,
) {
  const ratio = "t.peak_input_tokens * 100.0 / t.model_context_window";
  const hasMetadata = "t.model_context_window > 0 and t.peak_input_tokens is not null";
  switch (pressure) {
    case "below-70":
      conditions.push(`${hasMetadata} and ${ratio} < 70`);
      return;
    case "70-84":
      conditions.push(`${hasMetadata} and ${ratio} >= 70 and ${ratio} < 85`);
      return;
    case "85-94":
      conditions.push(`${hasMetadata} and ${ratio} >= 85 and ${ratio} < 95`);
      return;
    case "95+":
      conditions.push(`${hasMetadata} and ${ratio} >= 95`);
      return;
    case "unknown":
      conditions.push(
        "(t.model_context_window is null or t.model_context_window <= 0 or t.peak_input_tokens is null)",
      );
      return;
    case "70":
    case "85":
    case "95":
      conditions.push(`${hasMetadata} and ${ratio} >= ?`);
      params.push(Number(pressure));
  }
}

function coverage(requestCount: number, unknownCostCount: number): TurnCostCoverage {
  if (requestCount === 0 || unknownCostCount === 0) return "exact";
  return unknownCostCount >= requestCount ? "unavailable" : "partial";
}

function contextPercent(value: number | null, window: number | null): number | null {
  return value !== null && window !== null && window > 0 ? (value / window) * 100 : null;
}

function readPercentile(
  database: AppDatabase,
  filters: FilterSql,
  column: "duration_ms" | "time_to_first_token_ms",
  fraction: number,
): number | null {
  const countRow = database.$client
    .prepare(
      `select count(t.${column}) as count
      from turns t
      join sessions s on s.id = t.session_id
      join session_agents a on a.id = t.agent_id
      where ${filters.where} and t.${column} is not null`,
    )
    .get(...filters.params) as { count: number } | undefined;
  const count = Number(countRow?.count ?? 0);
  if (count === 0) return null;

  const offset = Math.min(count - 1, Math.max(0, Math.ceil(count * fraction) - 1));
  const row = database.$client
    .prepare(
      `select t.${column} as value
      from turns t
      join sessions s on s.id = t.session_id
      join session_agents a on a.id = t.agent_id
      where ${filters.where} and t.${column} is not null
      order by t.${column} asc, t.id asc
      limit 1 offset ?`,
    )
    .get(...filters.params, offset) as { value: number } | undefined;
  return row ? Number(row.value) : null;
}

function diagnosticBaseline(values: number[], total: number): TurnDiagnosticBaseline {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length < DIAGNOSTIC_MINIMUM_SAMPLE) {
    return {
      baselineAvailable: false,
      eligibleCount: sorted.length,
      median: null,
      p95: null,
      unavailableCount: total - sorted.length,
    };
  }
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted.at(middle - 1)! + sorted.at(middle)!) / 2
      : sorted.at(middle)!;
  return {
    baselineAvailable: true,
    eligibleCount: sorted.length,
    median,
    p95: sorted.at(Math.ceil(sorted.length * 0.95) - 1)!,
    unavailableCount: total - sorted.length,
  };
}

function diagnosticOutlier(value: number | null, baseline: TurnDiagnosticBaseline): boolean {
  return (
    value !== null &&
    baseline.baselineAvailable &&
    baseline.median !== null &&
    baseline.p95 !== null &&
    baseline.p95 > baseline.median &&
    value >= baseline.p95
  );
}

function diagnosticP95Ratio(value: number | null, baseline: TurnDiagnosticBaseline): number {
  return value !== null && baseline.p95 !== null && baseline.p95 > 0 ? value / baseline.p95 : 0;
}

function diagnosticContextReason(value: number | null): TurnDiagnosticReason | null {
  if (value === null || value < 70) return null;
  if (value >= 95) return "context-95";
  if (value >= 85) return "context-85";
  return "context-70";
}

function diagnosticContextSeverity(value: number | null): number {
  if (value === null || value < 70) return 0;
  if (value >= 95) return 3;
  return value >= 85 ? 2 : 1;
}

function inclusiveDayCount(from: string, to: string): number {
  return (
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ) + 1
  );
}

function sortSql(sort: NonNullable<TurnFilters["sort"]>, order: "asc" | "desc"): string {
  const direction = order === "asc" ? "asc" : "desc";
  let expression: string;
  switch (sort) {
    case "context":
      expression =
        "case when t.model_context_window > 0 then t.peak_input_tokens * 1.0 / t.model_context_window else null end";
      break;
    case "cost":
      expression = "coalesce(u.cost_usd, 0)";
      break;
    case "duration":
      expression = "t.duration_ms";
      break;
    case "lastActivity":
      expression = "t.last_event_at";
      break;
    case "tokens":
      expression = "coalesce(u.total_tokens, 0)";
      break;
    case "ttft":
      expression = "t.time_to_first_token_ms";
      break;
  }
  return `${expression} ${direction}`;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
