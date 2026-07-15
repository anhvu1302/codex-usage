import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import type { AppDatabase } from "@/server/db/client";
import {
  modelRates,
  sessionAgents,
  sessions,
  usageAgentDailyRollups,
  usageDailyRollups,
  usageEvents,
  usageHourlyRollups,
  usageRollupSessionMemberships,
} from "@/server/db/schema";
import { getRetentionCoverage, getSessionCoverage } from "@/server/retention";
import type {
  DashboardFilters,
  DashboardKpis,
  DashboardResponse,
  ModelRate,
  SessionAgentUsage,
  SessionFilters,
  SessionsResponse,
} from "@/shared/types";

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
  const coverage = getSessionCoverage(filters, now);
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  if (!coverage.from || !coverage.to) return { coverage, page, pageSize, sessions: [], total: 0 };
  const effectiveFilters = {
    ...(filters.agentKind ? { agentKind: filters.agentKind } : {}),
    from: coverage.from,
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.models ? { models: filters.models } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    to: coverage.to,
  };
  const where = usageWhere(effectiveFilters);
  const rows = database
    .select({
      cwd: sessions.cwd,
      firstEventAt: sql<string>`min(${usageEvents.timestamp})`,
      lastEventAt: sql<string>`max(${usageEvents.timestamp})`,
      models: sql<string>`group_concat(distinct ${usageEvents.model})`,
      projectId: sessions.projectId,
      sessionId: usageEvents.sessionId,
      sourceDeleted: sessions.sourceDeleted,
      title: sessions.title,
      ...aggregateFields,
    })
    .from(usageEvents)
    .leftJoin(sessions, eq(usageEvents.sessionId, sessions.id))
    .where(where)
    .groupBy(
      usageEvents.sessionId,
      sessions.cwd,
      sessions.projectId,
      sessions.sourceDeleted,
      sessions.title,
    )
    .orderBy(desc(sql`max(${usageEvents.timestamp})`))
    .all();

  const agentsBySession = new Map<string, SessionAgentUsage[]>();
  for (const agent of getSessionAgents(database, effectiveFilters)) {
    const agents = agentsBySession.get(agent.sessionId) ?? [];
    agents.push(agent);
    agentsBySession.set(agent.sessionId, agents);
  }

  let values = rows.map((row) => ({
    agents: agentsBySession.get(row.sessionId) ?? [],
    cwd: row.cwd,
    firstEventAt: row.firstEventAt,
    lastEventAt: row.lastEventAt,
    models: row.models.split(",").filter(Boolean),
    projectId: row.projectId,
    sessionId: row.sessionId,
    sourceDeleted: row.sourceDeleted ?? true,
    title: row.title,
    ...toKpis(row),
  }));
  const query = filters.query?.trim().toLocaleLowerCase();
  if (query) {
    values = values.filter((session) =>
      [
        session.title,
        session.sessionId,
        session.cwd,
        ...session.agents.flatMap((agent) => [agent.name, agent.role]),
      ].some((value) => value?.toLocaleLowerCase().includes(query)),
    );
  }
  if (filters.hasSubagents !== undefined) {
    values = values.filter(
      (session) => session.agents.some((agent) => agent.isSubagent) === filters.hasSubagents,
    );
  }
  const direction = filters.order === "asc" ? 1 : -1;
  values.sort((left, right) => {
    if (filters.sort === "tokens") return (left.totalTokens - right.totalTokens) * direction;
    if (filters.sort === "cost")
      return (left.estimatedCostUsd - right.estimatedCostUsd) * direction;
    return left.lastEventAt.localeCompare(right.lastEventAt) * direction;
  });
  const total = values.length;
  const start = (page - 1) * pageSize;

  return {
    coverage,
    page,
    pageSize,
    sessions: values.slice(start, start + pageSize),
    total,
  };
}

function getSessionAgents(
  database: AppDatabase,
  filters: DashboardFilters,
): (SessionAgentUsage & { sessionId: string })[] {
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
    return (
      rawResult.changes + dailyResult.changes + hourlyResult.changes + agentDailyResult.changes
    );
  });
}

export function backfillAllUnpricedUsage(database: AppDatabase): number {
  return database
    .select({ model: modelRates.model })
    .from(modelRates)
    .all()
    .reduce((total, rate) => total + backfillUnpricedUsage(database, rate.model), 0);
}

export function reconcileUnknownModels(database: AppDatabase): number {
  const result = database.run(sql`
    update ${usageEvents} as unknown_event
    set model = (
      select known_event.model
      from ${usageEvents} as known_event
      where known_event.session_id = unknown_event.session_id
        and known_event.model != 'unknown'
      order by abs(julianday(known_event.timestamp) - julianday(unknown_event.timestamp)), known_event.timestamp
      limit 1
    )
    where unknown_event.model = 'unknown'
      and exists (
        select 1
        from ${usageEvents} as known_event
        where known_event.session_id = unknown_event.session_id
          and known_event.model != 'unknown'
      )
  `);
  return result.changes;
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

function toNumber(value: number | string | null | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
