import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import type { AppDatabase } from "@/server/db/client";
import { modelRates, sessionAgents, sessions, usageEvents } from "@/server/db/schema";
import type {
  DashboardFilters,
  DashboardKpis,
  DashboardResponse,
  HourlyUsage,
  ModelRate,
  SessionAgentUsage,
  SessionUsage,
} from "@/shared/types";

export function getDashboard(database: AppDatabase, filters: DashboardFilters): DashboardResponse {
  const where = usageWhere(filters);
  const totals = database.select(aggregateFields).from(usageEvents).where(where).get();
  const kpis = toKpis(totals);
  const daily = database
    .select({ date: usageEvents.localDate, ...aggregateFields })
    .from(usageEvents)
    .where(where)
    .groupBy(usageEvents.localDate)
    .orderBy(asc(usageEvents.localDate))
    .all()
    .map((row) => ({ date: row.date, ...toKpis(row) }));
  const dailyModels = database
    .select({
      date: usageEvents.localDate,
      model: usageEvents.model,
      totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)`,
    })
    .from(usageEvents)
    .where(where)
    .groupBy(usageEvents.localDate, usageEvents.model)
    .orderBy(asc(usageEvents.localDate), asc(usageEvents.model))
    .all()
    .map((row) => ({ ...row, totalTokens: toNumber(row.totalTokens) }));
  const models = database
    .select({ model: usageEvents.model, ...aggregateFields })
    .from(usageEvents)
    .where(where)
    .groupBy(usageEvents.model)
    .orderBy(desc(sql`sum(${usageEvents.totalTokens})`))
    .all()
    .map((row) => {
      const usage = toKpis(row);
      return {
        model: row.model,
        tokenShare: kpis.totalTokens === 0 ? 0 : usage.totalTokens / kpis.totalTokens,
        ...usage,
      };
    });

  return {
    daily,
    dailyModels,
    hourly: filters.from === filters.to ? getHourlyUsage(database, filters) : [],
    hourlyModels: filters.from === filters.to ? getHourlyModelUsage(database, filters) : [],
    kpis,
    models,
  };
}

function getHourlyUsage(database: AppDatabase, filters: DashboardFilters): HourlyUsage[] {
  const localHour = sql<string>`strftime('%H', datetime(${usageEvents.timestamp}, '+7 hours'))`;
  const rows = database
    .select({ hour: localHour, ...aggregateFields })
    .from(usageEvents)
    .where(usageWhere(filters))
    .groupBy(localHour)
    .all();
  const usageByHour = new Map(rows.map((row) => [row.hour, toKpis(row)]));

  return Array.from({ length: 24 }, (_, hour) => {
    const key = String(hour).padStart(2, "0");
    return { hour: `${key}:00`, ...emptyKpis(), ...(usageByHour.get(key) ?? {}) };
  });
}

function getHourlyModelUsage(database: AppDatabase, filters: DashboardFilters) {
  const localHour = sql<string>`strftime('%H', datetime(${usageEvents.timestamp}, '+7 hours'))`;
  return database
    .select({
      hour: localHour,
      model: usageEvents.model,
      totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)`,
    })
    .from(usageEvents)
    .where(usageWhere(filters))
    .groupBy(localHour, usageEvents.model)
    .orderBy(asc(localHour), asc(usageEvents.model))
    .all()
    .map((row) => ({
      hour: `${row.hour}:00`,
      model: row.model,
      totalTokens: toNumber(row.totalTokens),
    }));
}

export function getSessions(database: AppDatabase, filters: DashboardFilters): SessionUsage[] {
  const where = usageWhere(filters);
  const rows = database
    .select({
      cwd: sessions.cwd,
      firstEventAt: sql<string>`min(${usageEvents.timestamp})`,
      lastEventAt: sql<string>`max(${usageEvents.timestamp})`,
      models: sql<string>`group_concat(distinct ${usageEvents.model})`,
      sessionId: usageEvents.sessionId,
      sourceDeleted: sessions.sourceDeleted,
      title: sessions.title,
      ...aggregateFields,
    })
    .from(usageEvents)
    .leftJoin(sessions, eq(usageEvents.sessionId, sessions.id))
    .where(where)
    .groupBy(usageEvents.sessionId, sessions.cwd, sessions.sourceDeleted, sessions.title)
    .orderBy(desc(sql`max(${usageEvents.timestamp})`))
    .all();

  const agentsBySession = new Map<string, SessionAgentUsage[]>();
  for (const agent of getSessionAgents(database, filters)) {
    const agents = agentsBySession.get(agent.sessionId) ?? [];
    agents.push(agent);
    agentsBySession.set(agent.sessionId, agents);
  }

  return rows.map((row) => ({
    agents: agentsBySession.get(row.sessionId) ?? [],
    cwd: row.cwd,
    firstEventAt: row.firstEventAt,
    lastEventAt: row.lastEventAt,
    models: row.models.split(",").filter(Boolean),
    sessionId: row.sessionId,
    sourceDeleted: row.sourceDeleted ?? true,
    title: row.title,
    ...toKpis(row),
  }));
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
      sessionAgents.role,
      sessionAgents.sessionId,
      sessionAgents.sourceDeleted,
      sessionAgents.taskSummary,
      sessionAgents.threadSource,
    )
    .all();

  return rows.flatMap((row) => {
    if (!row.firstEventAt || !row.lastEventAt) return [];
    const kpis = toKpis(row);
    return [
      {
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
        reasoningOutputTokens: kpis.reasoningOutputTokens,
        requestCount: kpis.requestCount,
        role: row.role,
        sessionId: row.sessionId,
        sourceDeleted: row.sourceDeleted,
        taskSummary: row.taskSummary,
        totalTokens: kpis.totalTokens,
        unpricedUsageCount: kpis.unpricedUsageCount,
      },
    ];
  });
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

  const result = database
    .update(usageEvents)
    .set({
      cachedInputRate: rate.cachedInputRate,
      costUsd: sql<number>`((${usageEvents.inputTokens} - ${usageEvents.cachedInputTokens}) * ${rate.inputRate} + ${usageEvents.cachedInputTokens} * ${rate.cachedInputRate} + ${usageEvents.outputTokens} * ${rate.outputRate}) / 1000000.0`,
      inputRate: rate.inputRate,
      outputRate: rate.outputRate,
    })
    .where(and(eq(usageEvents.model, model), isNull(usageEvents.costUsd)))
    .run();
  return result.changes;
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

const aggregateFields = {
  cachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)`,
  estimatedCostUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)`,
  inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
  requestCount: sql<number>`count(${usageEvents.id})`,
  reasoningOutputTokens: sql<number>`coalesce(sum(${usageEvents.reasoningOutputTokens}), 0)`,
  sessionCount: sql<number>`count(distinct ${usageEvents.sessionId})`,
  totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)`,
  unpricedUsageCount: sql<number>`coalesce(sum(case when ${usageEvents.costUsd} is null then 1 else 0 end), 0)`,
};

function usageWhere(filters: DashboardFilters) {
  const conditions = [
    gte(usageEvents.localDate, filters.from),
    lte(usageEvents.localDate, filters.to),
  ];
  if (filters.model) conditions.push(eq(usageEvents.model, filters.model));
  return and(...conditions);
}

type AggregateRow = {
  [Key in keyof typeof aggregateFields]: number | string | null;
};

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

function emptyKpis(): DashboardKpis {
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

function toNumber(value: number | string | null | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
