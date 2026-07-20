import { createHash } from "node:crypto";

import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";

import type { AppDatabase } from "@/server/db/client";
import {
  activityDailyRollups,
  activityEvents,
  importDiagnostics,
  projectTags,
  sessionAgents,
  sessions,
  turnModelUsage,
  usageDailyRollups,
  usageEvents,
} from "@/server/db/schema";
import type { SessionImporter } from "@/server/importer";
import { getRetentionCoverage, type RetentionService } from "@/server/retention";
import type {
  ActivityDailyUsage,
  ActivityFilters,
  ActivityKind,
  ActivityResponse,
  ActivitySummaryResponse,
  ActivitySummary,
  ActivityTimelineResponse,
  ActivityTimelineItem,
  DataHealthResponse,
} from "@/shared/types";

const ACTIVITY_TIMELINE_LIMIT = 2_000;
const ACTIVITY_PAGE_LIMIT = 200;

export class InvalidActivityCursorError extends Error {
  constructor() {
    super("Invalid activity timeline cursor");
    this.name = "InvalidActivityCursorError";
  }
}

export function getActivity(database: AppDatabase, filters: ActivityFilters): ActivityResponse {
  const summary = getActivitySummary(database, filters);
  const timeline = readActivityTimeline(database, filters, ACTIVITY_TIMELINE_LIMIT, null);
  return {
    daily: summary.daily,
    timeline: timeline.items,
    timelineCoverage: summary.timelineCoverage,
    timelineTruncated: timeline.hasMore,
  };
}

export function getActivitySummary(
  database: AppDatabase,
  filters: ActivityFilters,
): ActivitySummaryResponse {
  const rawConditions = activityConditions(activityEvents, filters);
  if (filters.sessionId) rawConditions.push(eq(activityEvents.sessionId, filters.sessionId));

  const rawDaily = database
    .select({
      agentKind: activityEvents.agentKind,
      count: sql<number>`count(*)`,
      date: activityEvents.localDate,
      kind: activityEvents.kind,
      projectId: activityEvents.projectId,
    })
    .from(activityEvents)
    .where(and(...rawConditions))
    .groupBy(
      activityEvents.localDate,
      activityEvents.kind,
      activityEvents.agentKind,
      activityEvents.projectId,
    )
    .all();

  const archivedDaily = filters.sessionId
    ? []
    : database
        .select({
          agentKind: activityDailyRollups.agentKind,
          count: activityDailyRollups.eventCount,
          date: activityDailyRollups.localDate,
          kind: activityDailyRollups.kind,
          projectId: activityDailyRollups.projectId,
        })
        .from(activityDailyRollups)
        .where(and(...activityConditions(activityDailyRollups, filters)))
        .all();

  const total = database
    .select({ count: sql<number>`count(*)` })
    .from(activityEvents)
    .where(and(...rawConditions))
    .get();

  const rawDailyUsage = database
    .select({
      date: usageEvents.localDate,
      estimatedCostUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)`,
      requestCount: sql<number>`count(*)`,
      totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)`,
      unpricedUsageCount: sql<number>`coalesce(sum(case when ${usageEvents.costUsd} is null then 1 else 0 end), 0)`,
    })
    .from(usageEvents)
    .where(and(...activityUsageConditions(filters)))
    .groupBy(usageEvents.localDate)
    .all()
    .map(toActivityDailyUsage);

  const archivedDailyUsage = filters.sessionId
    ? []
    : database
        .select({
          date: usageDailyRollups.localDate,
          estimatedCostUsd: sql<number>`coalesce(sum(${usageDailyRollups.costUsd}), 0)`,
          requestCount: sql<number>`coalesce(sum(${usageDailyRollups.requestCount}), 0)`,
          totalTokens: sql<number>`coalesce(sum(${usageDailyRollups.totalTokens}), 0)`,
          unpricedUsageCount: sql<number>`coalesce(sum(${usageDailyRollups.unpricedUsageCount}), 0)`,
        })
        .from(usageDailyRollups)
        .where(and(...activityDailyUsageConditions(filters)))
        .groupBy(usageDailyRollups.localDate)
        .all()
        .map(toActivityDailyUsage);

  return {
    daily: mergeDailyActivity([...archivedDaily, ...rawDaily]),
    dailyUsage: mergeActivityDailyUsage([...archivedDailyUsage, ...rawDailyUsage]),
    timelineCoverage: activityTimelineCoverage(filters),
    timelineTotal: toNumber(total?.count),
  };
}

export function getActivityTimeline(
  database: AppDatabase,
  filters: ActivityFilters,
  options: { cursor?: string | undefined; limit?: number | undefined } = {},
): ActivityTimelineResponse {
  const limit = options.limit ?? ACTIVITY_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACTIVITY_PAGE_LIMIT) {
    throw new RangeError("Activity timeline limit must be between 1 and 200");
  }
  const cursor = options.cursor ? decodeActivityCursor(options.cursor, filters) : null;
  return readActivityTimeline(database, filters, limit, cursor);
}

function readActivityTimeline(
  database: AppDatabase,
  filters: ActivityFilters,
  limit: number,
  cursor: ActivityCursor | null,
): ActivityTimelineResponse {
  const conditions = activityConditions(activityEvents, filters);
  if (filters.sessionId) conditions.push(eq(activityEvents.sessionId, filters.sessionId));
  if (cursor) {
    conditions.push(
      or(
        lt(activityEvents.timestamp, cursor.timestamp),
        and(eq(activityEvents.timestamp, cursor.timestamp), lt(activityEvents.id, cursor.id)),
      )!,
    );
  }
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
    .where(and(...conditions))
    .orderBy(desc(activityEvents.timestamp), desc(activityEvents.id))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toTimelineItem);
  const last = items.at(-1);
  return {
    hasMore,
    items,
    nextCursor:
      hasMore && last
        ? encodeActivityCursor({ id: last.id, timestamp: last.timestamp }, filters)
        : null,
  };
}

type ActivityCursor = { id: string; timestamp: string };

function encodeActivityCursor(cursor: ActivityCursor, filters: ActivityFilters): string {
  return Buffer.from(
    JSON.stringify({
      f: activityFilterFingerprint(filters),
      i: cursor.id,
      t: cursor.timestamp,
      v: 1,
    }),
  ).toString("base64url");
}

function decodeActivityCursor(value: string, filters: ActivityFilters): ActivityCursor {
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidActivityCursorError();
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("v" in parsed) ||
      parsed.v !== 1 ||
      !("f" in parsed) ||
      parsed.f !== activityFilterFingerprint(filters) ||
      !("i" in parsed) ||
      typeof parsed.i !== "string" ||
      parsed.i.length === 0 ||
      !("t" in parsed) ||
      typeof parsed.t !== "string" ||
      parsed.t.length === 0
    ) {
      throw new InvalidActivityCursorError();
    }
    return { id: parsed.i, timestamp: parsed.t };
  } catch (error) {
    if (error instanceof InvalidActivityCursorError) throw error;
    throw new InvalidActivityCursorError();
  }
}

function activityFilterFingerprint(filters: ActivityFilters): string {
  const canonical = JSON.stringify({
    agentKind: filters.agentKind ?? "all",
    from: filters.from,
    kinds: [...(filters.kinds ?? [])].sort(),
    models: [
      ...new Set(filters.models?.length ? filters.models : filters.model ? [filters.model] : []),
    ].sort(),
    projectId: filters.projectId ?? null,
    sessionId: filters.sessionId ?? null,
    tagIds: [...(filters.tagIds ?? [])].sort(),
    to: filters.to,
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

export async function getDataHealth(
  database: AppDatabase,
  importer: SessionImporter,
  retention: RetentionService,
): Promise<DataHealthResponse> {
  const [storage, diagnostics] = await Promise.all([
    retention.getStatus(),
    Promise.resolve(
      database
        .select({
          incompleteFiles: sql<number>`sum(case when ${importDiagnostics.incompleteLine} = 1 then 1 else 0 end)`,
          malformedLines: sql<number>`coalesce(sum(${importDiagnostics.malformedLines}), 0)`,
        })
        .from(importDiagnostics)
        .get(),
    ),
  ]);
  const importStatus = importer.getStatus();
  const unknownRaw = database
    .select({ count: sql<number>`count(*)` })
    .from(usageEvents)
    .where(eq(usageEvents.model, "unknown"))
    .get();
  const unknownArchived = database
    .select({ count: sql<number>`coalesce(sum(${usageDailyRollups.requestCount}), 0)` })
    .from(usageDailyRollups)
    .where(eq(usageDailyRollups.model, "unknown"))
    .get();
  const unpricedRaw = database
    .select({ count: sql<number>`count(*)` })
    .from(usageEvents)
    .where(isNull(usageEvents.costUsd))
    .get();
  const unpricedArchived = database
    .select({ count: sql<number>`coalesce(sum(${usageDailyRollups.unpricedUsageCount}), 0)` })
    .from(usageDailyRollups)
    .get();
  const deletedSessions = database
    .select({ count: sql<number>`count(*)` })
    .from(sessions)
    .where(eq(sessions.sourceDeleted, true))
    .get();
  const deletedAgents = database
    .select({ count: sql<number>`count(*)` })
    .from(sessionAgents)
    .where(eq(sessionAgents.sourceDeleted, true))
    .get();
  const activityRaw = database
    .select({ count: sql<number>`count(*)` })
    .from(activityEvents)
    .get();
  const activityDaily = database
    .select({ count: sql<number>`count(*)` })
    .from(activityDailyRollups)
    .get();
  const retentionCoverage = getRetentionCoverage({ from: "0000-01-01", to: "9999-12-31" });
  const turnCostGaps = database
    .select({ count: sql<number>`coalesce(sum(${turnModelUsage.costAttributionMissingCount}), 0)` })
    .from(turnModelUsage)
    .get();
  const turnUnassignedUsage = database
    .select({ count: sql<number>`count(*)` })
    .from(usageEvents)
    .where(isNull(usageEvents.turnKey))
    .get();
  const turnUnassignedActivity = database
    .select({ count: sql<number>`count(*)` })
    .from(activityEvents)
    .where(isNull(activityEvents.turnKey))
    .get();

  return {
    activityDailyRows: toNumber(activityDaily?.count),
    activityRawEvents: toNumber(activityRaw?.count),
    hourlyCoverageFrom: retentionCoverage.hourlyFrom,
    incompleteFiles: toNumber(diagnostics?.incompleteFiles),
    importerError: importStatus.error,
    lastCompactionAt: storage.lastCompactionAt,
    lastSyncAt: importStatus.lastSyncAt,
    malformedLines: toNumber(diagnostics?.malformedLines),
    rawCoverageFrom: retentionCoverage.rawFrom,
    retentionError: storage.error,
    sourceDeletedAgents: toNumber(deletedAgents?.count),
    sourceDeletedSessions: toNumber(deletedSessions?.count),
    sourceScan: importStatus.sourceScan,
    turnBackfill: importStatus.turnBackfill,
    turnCostAttributionGaps: toNumber(turnCostGaps?.count),
    turnUnassignedActivity: toNumber(turnUnassignedActivity?.count),
    turnUnassignedUsage: toNumber(turnUnassignedUsage?.count),
    unknownUsage: toNumber(unknownRaw?.count) + toNumber(unknownArchived?.count),
    unpricedUsage: toNumber(unpricedRaw?.count) + toNumber(unpricedArchived?.count),
  };
}

type ActivityTable = typeof activityEvents | typeof activityDailyRollups;

function activityConditions(table: ActivityTable, filters: ActivityFilters): SQL[] {
  const conditions: SQL[] = [gte(table.localDate, filters.from), lte(table.localDate, filters.to)];
  if (filters.agentKind && filters.agentKind !== "all") {
    conditions.push(eq(table.agentKind, filters.agentKind));
  }
  if (filters.projectId) conditions.push(eq(table.projectId, filters.projectId));
  if (filters.tagIds?.length) {
    conditions.push(sql`exists (
      select 1 from ${projectTags}
      where ${projectTags.projectId} = ${table.projectId}
        and ${inArray(projectTags.tagId, filters.tagIds)}
    )`);
  }
  if (filters.kinds && filters.kinds.length > 0)
    conditions.push(inArray(table.kind, filters.kinds));
  return conditions;
}

function activityUsageConditions(filters: ActivityFilters): SQL[] {
  const conditions: SQL[] = [
    gte(usageEvents.localDate, filters.from),
    lte(usageEvents.localDate, filters.to),
  ];
  if (filters.sessionId) conditions.push(eq(usageEvents.sessionId, filters.sessionId));
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
  return conditions;
}

function activityDailyUsageConditions(filters: ActivityFilters): SQL[] {
  const conditions: SQL[] = [
    gte(usageDailyRollups.localDate, filters.from),
    lte(usageDailyRollups.localDate, filters.to),
  ];
  if (filters.agentKind && filters.agentKind !== "all") {
    conditions.push(eq(usageDailyRollups.agentKind, filters.agentKind));
  }
  if (filters.projectId) {
    conditions.push(eq(usageDailyRollups.projectId, filters.projectId));
  }
  if (filters.tagIds?.length) {
    conditions.push(sql`exists (
      select 1 from ${projectTags}
      where ${projectTags.projectId} = ${usageDailyRollups.projectId}
        and ${inArray(projectTags.tagId, filters.tagIds)}
    )`);
  }
  return conditions;
}

function mergeDailyActivity(
  rows: {
    agentKind: string;
    count: number;
    date: string;
    kind: string;
    projectId: string;
  }[],
): ActivitySummary[] {
  const totals = new Map<string, ActivitySummary>();
  for (const row of rows) {
    const agentKind = row.agentKind === "subagent" ? "subagent" : "main";
    const kind = row.kind as ActivityKind;
    const key = `${row.date}\u0000${kind}\u0000${agentKind}\u0000${row.projectId}`;
    const existing = totals.get(key);
    if (existing) {
      existing.count += toNumber(row.count);
      continue;
    }
    totals.set(key, {
      agentKind,
      count: toNumber(row.count),
      date: row.date,
      kind,
      projectId: row.projectId,
    });
  }
  return [...totals.values()].sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.kind.localeCompare(right.kind) ||
      left.projectId.localeCompare(right.projectId),
  );
}

function toActivityDailyUsage(row: {
  date: string;
  estimatedCostUsd: number;
  requestCount: number;
  totalTokens: number;
  unpricedUsageCount: number;
}): ActivityDailyUsage {
  return {
    date: row.date,
    estimatedCostUsd: toNumber(row.estimatedCostUsd),
    requestCount: toNumber(row.requestCount),
    totalTokens: toNumber(row.totalTokens),
    unpricedUsageCount: toNumber(row.unpricedUsageCount),
  };
}

function mergeActivityDailyUsage(rows: ActivityDailyUsage[]): ActivityDailyUsage[] {
  const totals = new Map<string, ActivityDailyUsage>();
  for (const row of rows) {
    const existing = totals.get(row.date);
    if (existing) {
      existing.estimatedCostUsd += row.estimatedCostUsd;
      existing.requestCount += row.requestCount;
      existing.totalTokens += row.totalTokens;
      existing.unpricedUsageCount += row.unpricedUsageCount;
      continue;
    }
    totals.set(row.date, { ...row });
  }
  return [...totals.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function toTimelineItem(row: {
  agentId: string;
  agentKind: string;
  depth: number | null;
  id: string;
  kind: string;
  name: string | null;
  parentAgentId: string | null;
  projectId: string;
  role: string | null;
  sessionId: string;
  timestamp: string;
  turnKey: string | null;
}): ActivityTimelineItem {
  return {
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
  };
}

function activityTimelineCoverage(filters: ActivityFilters) {
  const coverage = getRetentionCoverage(filters);
  if (coverage.sessionDetails === "none") return { from: null, status: "none" as const, to: null };
  return {
    from: filters.from < coverage.rawFrom ? coverage.rawFrom : filters.from,
    status: coverage.sessionDetails,
    to: filters.to,
  };
}

function toNumber(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}
