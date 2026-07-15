import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";

import type { AppDatabase } from "@/server/db/client";
import {
  activityDailyRollups,
  activityEvents,
  importDiagnostics,
  sessionAgents,
  sessions,
  usageDailyRollups,
  usageEvents,
} from "@/server/db/schema";
import type { SessionImporter } from "@/server/importer";
import { getRetentionCoverage, type RetentionService } from "@/server/retention";
import type {
  ActivityFilters,
  ActivityKind,
  ActivityResponse,
  ActivitySummary,
  ActivityTimelineItem,
  DataHealthResponse,
} from "@/shared/types";

const ACTIVITY_TIMELINE_LIMIT = 2_000;

export function getActivity(database: AppDatabase, filters: ActivityFilters): ActivityResponse {
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

  const timelineRows = database
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
    })
    .from(activityEvents)
    .leftJoin(sessionAgents, eq(sessionAgents.id, activityEvents.agentId))
    .where(and(...rawConditions))
    .orderBy(desc(activityEvents.timestamp))
    .limit(ACTIVITY_TIMELINE_LIMIT + 1)
    .all();
  const timeline = timelineRows.slice(0, ACTIVITY_TIMELINE_LIMIT).map(toTimelineItem);

  return {
    daily: mergeDailyActivity([...archivedDaily, ...rawDaily]),
    timeline,
    timelineCoverage: activityTimelineCoverage(filters),
    timelineTruncated: timelineRows.length > ACTIVITY_TIMELINE_LIMIT,
  };
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
  if (filters.kinds && filters.kinds.length > 0)
    conditions.push(inArray(table.kind, filters.kinds));
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
