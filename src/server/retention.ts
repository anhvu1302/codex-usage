import { stat } from "node:fs/promises";

import { and, eq, lt, sql } from "drizzle-orm";

import type { AppDatabase } from "@/server/db/client";
import { reclaimDatabaseSpace } from "@/server/db/client";
import { SourceInventory } from "@/server/source-inventory";
import { TURN_ATTRIBUTION_VERSION } from "@/server/turn-constants";
import {
  activityDailyRollups,
  activityEvents,
  archivedActivityEventIds,
  archivedUsageEventIds,
  retentionState,
  sessionAgents,
  sessions,
  usageAgentDailyRollups,
  usageDailyRollups,
  usageEvents,
  usageHourlyRollups,
  usageRollupSessionMemberships,
} from "@/server/db/schema";
import type {
  DashboardFilters,
  RetentionCoverage,
  SessionCoverage,
  StorageStatus,
} from "@/shared/types";

const RAW_RETENTION_DAYS = 30;
const HOURLY_RETENTION_DAYS = 90;
const RETENTION_STATE_ID = "default";
const INITIAL_COMPACTION_DELAY_MS = 60_000;
const LOCAL_TIME_OFFSET_MS = 7 * 60 * 60 * 1000;

export type CompactionResult = {
  hourlyRowsDeleted: number;
  rawEventsDeleted: number;
  rollupRowsWritten: number;
};

export class RetentionService {
  private isCompacting = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly databasePath: string,
    sessionsDirectory: string,
    private readonly now: () => Date = () => new Date(),
    private readonly sourceInventory: SourceInventory = new SourceInventory(sessionsDirectory, now),
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.runScheduledCompaction(), INITIAL_COMPACTION_DELAY_MS);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async compact(): Promise<StorageStatus> {
    if (this.isCompacting) return this.getStatus();
    this.isCompacting = true;
    const startedAt = this.now();
    await Promise.resolve();

    try {
      const result = compactUsage(this.database, startedAt);
      this.saveState(startedAt, result, null);
      try {
        reclaimDatabaseSpace(this.database);
      } catch (error) {
        console.warn("Could not reclaim SQLite space after retention compaction", error);
      }
    } catch (error) {
      this.saveState(startedAt, emptyResult(), errorMessage(error));
    } finally {
      this.isCompacting = false;
    }

    return this.getStatus();
  }

  async getStatus(): Promise<StorageStatus> {
    const state = this.database
      .select()
      .from(retentionState)
      .where(eq(retentionState.id, RETENTION_STATE_ID))
      .get();
    const [databaseBytes, walBytes, cachedSourceSnapshot] = await Promise.all([
      fileSize(this.databasePath),
      fileSize(`${this.databasePath}-wal`),
      this.sourceInventory.getSummaryOrJoin(),
    ]);
    const sourceSnapshot = cachedSourceSnapshot ?? {
      scannedAt: null,
      sourceBytes: 0,
      sourceFileCount: 0,
    };
    const raw = this.database
      .select({
        count: sql<number>`count(*)`,
        oldest: sql<string | null>`min(${usageEvents.localDate})`,
      })
      .from(usageEvents)
      .get();
    const hourly = this.database
      .select({
        count: sql<number>`count(*)`,
        oldest: sql<string | null>`min(${usageHourlyRollups.localDate})`,
      })
      .from(usageHourlyRollups)
      .get();
    const daily = this.database
      .select({
        count: sql<number>`count(*)`,
        oldest: sql<string | null>`min(${usageDailyRollups.localDate})`,
      })
      .from(usageDailyRollups)
      .get();

    return {
      dailyRows: toNumber(daily?.count),
      databaseBytes,
      error: state?.error ?? null,
      hourlyRows: toNumber(hourly?.count),
      isCompacting: this.isCompacting,
      lastCompactionAt: state?.lastCompactionAt
        ? new Date(state.lastCompactionAt).toISOString()
        : null,
      lastHourlyRowsDeleted: state?.hourlyRowsDeleted ?? 0,
      lastRawEventsDeleted: state?.rawEventsDeleted ?? 0,
      lastRollupRowsWritten: state?.rollupRowsWritten ?? 0,
      oldestDailyDate: daily?.oldest ?? null,
      oldestHourlyDate: hourly?.oldest ?? null,
      oldestRawDate: raw?.oldest ?? null,
      policy: { dailyRetention: "forever", hourlyDays: 90, rawDays: 30 },
      rawEvents: toNumber(raw?.count),
      sourceBytes: sourceSnapshot.sourceBytes,
      sourceFileCount: sourceSnapshot.sourceFileCount,
      sourceManaged: false,
      sourceScannedAt: sourceSnapshot.scannedAt,
      walBytes,
    };
  }

  private async runScheduledCompaction() {
    await this.compact();
    this.scheduleNextDailyRun();
  }

  private scheduleNextDailyRun() {
    const now = this.now();
    const local = new Date(now.getTime() + LOCAL_TIME_OFFSET_MS);
    let target = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      3 - 7,
      15,
    );
    if (target <= now.getTime()) target += 24 * 60 * 60 * 1000;
    this.timer = setTimeout(() => void this.runScheduledCompaction(), target - now.getTime());
  }

  private saveState(at: Date, result: CompactionResult, error: string | null) {
    this.database
      .insert(retentionState)
      .values({
        error,
        hourlyRowsDeleted: result.hourlyRowsDeleted,
        id: RETENTION_STATE_ID,
        lastCompactionAt: at.getTime(),
        rawEventsDeleted: result.rawEventsDeleted,
        rollupRowsWritten: result.rollupRowsWritten,
      })
      .onConflictDoUpdate({
        target: retentionState.id,
        set: {
          error,
          hourlyRowsDeleted: result.hourlyRowsDeleted,
          lastCompactionAt: at.getTime(),
          rawEventsDeleted: result.rawEventsDeleted,
          rollupRowsWritten: result.rollupRowsWritten,
        },
      })
      .run();
  }
}

export function compactUsage(database: AppDatabase, now: Date): CompactionResult {
  const { hourlyFrom, rawFrom } = getRetentionCutoffs(now);
  const archivedAt = now.getTime();
  const unattributedUsage = database
    .select({ count: sql<number>`count(*)` })
    .from(usageEvents)
    .where(
      and(
        lt(usageEvents.localDate, rawFrom),
        sql`${usageEvents.turnAttributionVersion} != ${TURN_ATTRIBUTION_VERSION}`,
      ),
    )
    .get();
  const unattributedActivity = database
    .select({ count: sql<number>`count(*)` })
    .from(activityEvents)
    .where(
      and(
        lt(activityEvents.localDate, rawFrom),
        sql`${activityEvents.turnAttributionVersion} != ${TURN_ATTRIBUTION_VERSION}`,
      ),
    )
    .get();
  if (toNumber(unattributedUsage?.count) + toNumber(unattributedActivity?.count) > 0) {
    throw new Error("Turn attribution backfill must finish before retention compaction");
  }

  return database.transaction((transaction) => {
    const hourlyWrite = transaction.run(sql`
      insert into ${usageHourlyRollups} (
        local_date, local_hour, model, agent_kind, project_id,
        input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        request_count, cost_usd, unpriced_usage_count,
        unpriced_input_tokens, unpriced_cached_input_tokens, unpriced_output_tokens
      )
      select
        ${usageEvents.localDate},
        strftime('%H:00', datetime(${usageEvents.timestamp}, '+7 hours')),
        ${usageEvents.model},
        case when ${sessionAgents.threadSource} = 'subagent' then 'subagent' else 'main' end,
        coalesce(${sessions.projectId}, 'legacy-unknown'),
        sum(${usageEvents.inputTokens}),
        sum(${usageEvents.cachedInputTokens}),
        sum(${usageEvents.outputTokens}),
        sum(${usageEvents.reasoningOutputTokens}),
        sum(${usageEvents.totalTokens}),
        count(*),
        coalesce(sum(${usageEvents.costUsd}), 0),
        sum(case when ${usageEvents.costUsd} is null then 1 else 0 end),
        sum(case when ${usageEvents.costUsd} is null then ${usageEvents.inputTokens} else 0 end),
        sum(case when ${usageEvents.costUsd} is null then ${usageEvents.cachedInputTokens} else 0 end),
        sum(case when ${usageEvents.costUsd} is null then ${usageEvents.outputTokens} else 0 end)
      from ${usageEvents}
      left join ${sessionAgents} on ${sessionAgents.id} = ${usageEvents.agentId}
      left join ${sessions} on ${sessions.id} = ${usageEvents.sessionId}
      where ${usageEvents.localDate} < ${rawFrom}
      group by ${usageEvents.localDate}, 2, ${usageEvents.model}, 4, 5
      on conflict(local_date, local_hour, model, agent_kind, project_id) do update set
        input_tokens = input_tokens + excluded.input_tokens,
        cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        reasoning_output_tokens = reasoning_output_tokens + excluded.reasoning_output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        request_count = request_count + excluded.request_count,
        cost_usd = cost_usd + excluded.cost_usd,
        unpriced_usage_count = unpriced_usage_count + excluded.unpriced_usage_count,
        unpriced_input_tokens = unpriced_input_tokens + excluded.unpriced_input_tokens,
        unpriced_cached_input_tokens = unpriced_cached_input_tokens + excluded.unpriced_cached_input_tokens,
        unpriced_output_tokens = unpriced_output_tokens + excluded.unpriced_output_tokens
    `);
    const dailyWrite = transaction.run(sql`
      insert into ${usageDailyRollups} (
        local_date, model, agent_kind, project_id,
        input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        request_count, cost_usd, unpriced_usage_count,
        unpriced_input_tokens, unpriced_cached_input_tokens, unpriced_output_tokens
      )
      select
        ${usageEvents.localDate},
        ${usageEvents.model},
        case when ${sessionAgents.threadSource} = 'subagent' then 'subagent' else 'main' end,
        coalesce(${sessions.projectId}, 'legacy-unknown'),
        sum(${usageEvents.inputTokens}),
        sum(${usageEvents.cachedInputTokens}),
        sum(${usageEvents.outputTokens}),
        sum(${usageEvents.reasoningOutputTokens}),
        sum(${usageEvents.totalTokens}),
        count(*),
        coalesce(sum(${usageEvents.costUsd}), 0),
        sum(case when ${usageEvents.costUsd} is null then 1 else 0 end),
        sum(case when ${usageEvents.costUsd} is null then ${usageEvents.inputTokens} else 0 end),
        sum(case when ${usageEvents.costUsd} is null then ${usageEvents.cachedInputTokens} else 0 end),
        sum(case when ${usageEvents.costUsd} is null then ${usageEvents.outputTokens} else 0 end)
      from ${usageEvents}
      left join ${sessionAgents} on ${sessionAgents.id} = ${usageEvents.agentId}
      left join ${sessions} on ${sessions.id} = ${usageEvents.sessionId}
      where ${usageEvents.localDate} < ${rawFrom}
      group by ${usageEvents.localDate}, ${usageEvents.model}, 3, 4
      on conflict(local_date, model, agent_kind, project_id) do update set
        input_tokens = input_tokens + excluded.input_tokens,
        cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        reasoning_output_tokens = reasoning_output_tokens + excluded.reasoning_output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        request_count = request_count + excluded.request_count,
        cost_usd = cost_usd + excluded.cost_usd,
        unpriced_usage_count = unpriced_usage_count + excluded.unpriced_usage_count,
        unpriced_input_tokens = unpriced_input_tokens + excluded.unpriced_input_tokens,
        unpriced_cached_input_tokens = unpriced_cached_input_tokens + excluded.unpriced_cached_input_tokens,
        unpriced_output_tokens = unpriced_output_tokens + excluded.unpriced_output_tokens
    `);
    const agentDailyWrite = transaction.run(sql`
      insert into ${usageAgentDailyRollups} (
        local_date, agent_id, session_id, model, agent_kind, project_id,
        input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        request_count, cost_usd, unpriced_usage_count,
        unpriced_input_tokens, unpriced_cached_input_tokens, unpriced_output_tokens
      )
      select
        ${usageEvents.localDate},
        ${usageEvents.agentId},
        ${usageEvents.sessionId},
        ${usageEvents.model},
        case when ${sessionAgents.threadSource} = 'subagent' then 'subagent' else 'main' end,
        coalesce(${sessions.projectId}, 'legacy-unknown'),
        sum(${usageEvents.inputTokens}),
        sum(${usageEvents.cachedInputTokens}),
        sum(${usageEvents.outputTokens}),
        sum(${usageEvents.reasoningOutputTokens}),
        sum(${usageEvents.totalTokens}),
        count(*),
        coalesce(sum(${usageEvents.costUsd}), 0),
        sum(case when ${usageEvents.costUsd} is null then 1 else 0 end),
        sum(case when ${usageEvents.costUsd} is null then ${usageEvents.inputTokens} else 0 end),
        sum(case when ${usageEvents.costUsd} is null then ${usageEvents.cachedInputTokens} else 0 end),
        sum(case when ${usageEvents.costUsd} is null then ${usageEvents.outputTokens} else 0 end)
      from ${usageEvents}
      left join ${sessionAgents} on ${sessionAgents.id} = ${usageEvents.agentId}
      left join ${sessions} on ${sessions.id} = ${usageEvents.sessionId}
      where ${usageEvents.localDate} < ${rawFrom}
      group by
        ${usageEvents.localDate},
        ${usageEvents.agentId},
        ${usageEvents.sessionId},
        ${usageEvents.model},
        5,
        6
      on conflict(local_date, agent_id, session_id, model, agent_kind, project_id) do update set
        input_tokens = input_tokens + excluded.input_tokens,
        cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        reasoning_output_tokens = reasoning_output_tokens + excluded.reasoning_output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        request_count = request_count + excluded.request_count,
        cost_usd = cost_usd + excluded.cost_usd,
        unpriced_usage_count = unpriced_usage_count + excluded.unpriced_usage_count,
        unpriced_input_tokens = unpriced_input_tokens + excluded.unpriced_input_tokens,
        unpriced_cached_input_tokens = unpriced_cached_input_tokens + excluded.unpriced_cached_input_tokens,
        unpriced_output_tokens = unpriced_output_tokens + excluded.unpriced_output_tokens
    `);
    transaction.run(sql`
      insert into ${activityDailyRollups} (
        local_date, kind, agent_kind, project_id, event_count
      )
      select
        ${activityEvents.localDate},
        ${activityEvents.kind},
        ${activityEvents.agentKind},
        ${activityEvents.projectId},
        count(*)
      from ${activityEvents}
      where ${activityEvents.localDate} < ${rawFrom}
      group by
        ${activityEvents.localDate},
        ${activityEvents.kind},
        ${activityEvents.agentKind},
        ${activityEvents.projectId}
      on conflict(local_date, kind, agent_kind, project_id) do update set
        event_count = event_count + excluded.event_count
    `);

    transaction.run(sql`
      insert or ignore into ${usageRollupSessionMemberships}
        (bucket_type, bucket_start, model, agent_kind, project_id, session_id)
      select
        'hour',
        ${usageEvents.localDate} || 'T' || strftime('%H:00', datetime(${usageEvents.timestamp}, '+7 hours')),
        ${usageEvents.model},
        case when ${sessionAgents.threadSource} = 'subagent' then 'subagent' else 'main' end,
        coalesce(${sessions.projectId}, 'legacy-unknown'),
        ${usageEvents.sessionId}
      from ${usageEvents}
      left join ${sessionAgents} on ${sessionAgents.id} = ${usageEvents.agentId}
      left join ${sessions} on ${sessions.id} = ${usageEvents.sessionId}
      where ${usageEvents.localDate} < ${rawFrom}
    `);
    transaction.run(sql`
      insert or ignore into ${usageRollupSessionMemberships}
        (bucket_type, bucket_start, model, agent_kind, project_id, session_id)
      select
        'day',
        ${usageEvents.localDate},
        ${usageEvents.model},
        case when ${sessionAgents.threadSource} = 'subagent' then 'subagent' else 'main' end,
        coalesce(${sessions.projectId}, 'legacy-unknown'),
        ${usageEvents.sessionId}
      from ${usageEvents}
      left join ${sessionAgents} on ${sessionAgents.id} = ${usageEvents.agentId}
      left join ${sessions} on ${sessions.id} = ${usageEvents.sessionId}
      where ${usageEvents.localDate} < ${rawFrom}
    `);
    transaction.run(sql`
      insert or ignore into ${archivedUsageEventIds}
        (id, archived_at, turn_key, turn_attribution_version)
      select
        ${usageEvents.id}, ${archivedAt}, ${usageEvents.turnKey},
        ${usageEvents.turnAttributionVersion}
      from ${usageEvents}
      where ${usageEvents.localDate} < ${rawFrom}
    `);
    transaction.run(sql`
      insert or ignore into ${archivedActivityEventIds}
        (id, archived_at, turn_key, turn_attribution_version)
      select
        ${activityEvents.id}, ${archivedAt}, ${activityEvents.turnKey},
        ${activityEvents.turnAttributionVersion}
      from ${activityEvents}
      where ${activityEvents.localDate} < ${rawFrom}
    `);

    const rawDelete = transaction
      .delete(usageEvents)
      .where(lt(usageEvents.localDate, rawFrom))
      .run();
    transaction.delete(activityEvents).where(lt(activityEvents.localDate, rawFrom)).run();
    const hourlyDelete = transaction
      .delete(usageHourlyRollups)
      .where(lt(usageHourlyRollups.localDate, hourlyFrom))
      .run();
    const hourlyMembershipDelete = transaction
      .delete(usageRollupSessionMemberships)
      .where(
        and(
          eq(usageRollupSessionMemberships.bucketType, "hour"),
          lt(usageRollupSessionMemberships.bucketStart, `${hourlyFrom}T00:00`),
        ),
      )
      .run();

    return {
      hourlyRowsDeleted: hourlyDelete.changes + hourlyMembershipDelete.changes,
      rawEventsDeleted: rawDelete.changes,
      rollupRowsWritten: hourlyWrite.changes + dailyWrite.changes + agentDailyWrite.changes,
    };
  });
}

function getRetentionCutoffs(now = new Date()) {
  const today = currentLocalDate(now);
  return {
    hourlyFrom: dateDaysBefore(today, HOURLY_RETENTION_DAYS - 1),
    rawFrom: dateDaysBefore(today, RAW_RETENTION_DAYS - 1),
    today,
  };
}

export function getRetentionCoverage(
  filters: DashboardFilters,
  now = new Date(),
): RetentionCoverage {
  const { hourlyFrom, rawFrom } = getRetentionCutoffs(now);
  return {
    hourlyAvailable: filters.from === filters.to && filters.from >= hourlyFrom,
    hourlyFrom,
    rawFrom,
    sessionDetails: filters.from >= rawFrom ? "full" : filters.to < rawFrom ? "none" : "partial",
  };
}

export function getSessionCoverage(filters: DashboardFilters, now = new Date()): SessionCoverage {
  const coverage = getRetentionCoverage(filters, now);
  if (coverage.sessionDetails === "none") return { from: null, status: "none", to: null };
  return {
    from: filters.from < coverage.rawFrom ? coverage.rawFrom : filters.from,
    status: coverage.sessionDetails,
    to: filters.to,
  };
}

export function currentLocalDate(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}

export function dateDaysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function emptyResult(): CompactionResult {
  return { hourlyRowsDeleted: 0, rawEventsDeleted: 0, rollupRowsWritten: 0 };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown retention error";
  const cause = error.cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

function toNumber(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}
