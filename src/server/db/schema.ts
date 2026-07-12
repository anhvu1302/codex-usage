import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    sourcePath: text("source_path").notNull(),
    cwd: text("cwd"),
    title: text("title"),
    startedAt: text("started_at"),
    lastSeenAt: integer("last_seen_at").notNull(),
    sourceDeleted: integer("source_deleted", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("sessions_source_path_index").on(table.sourcePath)],
);

export const sessionAgents = sqliteTable(
  "session_agents",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    sourcePath: text("source_path").notNull(),
    threadSource: text("thread_source").notNull(),
    parentThreadId: text("parent_thread_id"),
    name: text("name"),
    role: text("role"),
    depth: integer("depth").notNull().default(0),
    taskSummary: text("task_summary"),
    lastSeenAt: integer("last_seen_at").notNull(),
    sourceDeleted: integer("source_deleted", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("session_agents_session_index").on(table.sessionId),
    index("session_agents_source_path_index").on(table.sourcePath),
  ],
);

export const importStates = sqliteTable("import_states", {
  sourcePath: text("source_path").primaryKey(),
  lastOffset: integer("last_offset").notNull().default(0),
  sessionId: text("session_id"),
  agentId: text("agent_id"),
  dedupeVersion: integer("dedupe_version").notNull().default(0),
  activeModel: text("active_model"),
  updatedAt: integer("updated_at").notNull(),
});

export const modelRates = sqliteTable("model_rates", {
  model: text("model").primaryKey(),
  inputRate: real("input_rate").notNull(),
  cachedInputRate: real("cached_input_rate").notNull(),
  outputRate: real("output_rate").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    agentId: text("agent_id").notNull().default(""),
    sourceHash: text("source_hash").notNull(),
    timestamp: text("timestamp").notNull(),
    localDate: text("local_date").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningOutputTokens: integer("reasoning_output_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    inputRate: real("input_rate"),
    cachedInputRate: real("cached_input_rate"),
    outputRate: real("output_rate"),
    costUsd: real("cost_usd"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("usage_events_session_hash_unique").on(table.sessionId, table.sourceHash),
    index("usage_events_local_date_index").on(table.localDate),
    index("usage_events_model_index").on(table.model),
    index("usage_events_session_index").on(table.sessionId),
    index("usage_events_agent_index").on(table.agentId),
    index("usage_events_date_model_index").on(table.localDate, table.model),
    index("usage_events_date_session_index").on(table.localDate, table.sessionId),
  ],
);

const rollupFields = () => ({
  inputTokens: integer("input_tokens").notNull(),
  cachedInputTokens: integer("cached_input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  reasoningOutputTokens: integer("reasoning_output_tokens").notNull(),
  totalTokens: integer("total_tokens").notNull(),
  requestCount: integer("request_count").notNull(),
  costUsd: real("cost_usd").notNull(),
  unpricedUsageCount: integer("unpriced_usage_count").notNull(),
  unpricedInputTokens: integer("unpriced_input_tokens").notNull(),
  unpricedCachedInputTokens: integer("unpriced_cached_input_tokens").notNull(),
  unpricedOutputTokens: integer("unpriced_output_tokens").notNull(),
});

export const usageHourlyRollups = sqliteTable(
  "usage_hourly_rollups",
  {
    localDate: text("local_date").notNull(),
    localHour: text("local_hour").notNull(),
    model: text("model").notNull(),
    agentKind: text("agent_kind").notNull(),
    ...rollupFields(),
  },
  (table) => [
    primaryKey({ columns: [table.localDate, table.localHour, table.model, table.agentKind] }),
    index("usage_hourly_rollups_model_date_index").on(table.model, table.localDate),
  ],
);

export const usageDailyRollups = sqliteTable(
  "usage_daily_rollups",
  {
    localDate: text("local_date").notNull(),
    model: text("model").notNull(),
    agentKind: text("agent_kind").notNull(),
    ...rollupFields(),
  },
  (table) => [
    primaryKey({ columns: [table.localDate, table.model, table.agentKind] }),
    index("usage_daily_rollups_model_date_index").on(table.model, table.localDate),
  ],
);

export const usageRollupSessionMemberships = sqliteTable(
  "usage_rollup_session_memberships",
  {
    bucketType: text("bucket_type").notNull(),
    bucketStart: text("bucket_start").notNull(),
    model: text("model").notNull(),
    agentKind: text("agent_kind").notNull(),
    sessionId: text("session_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.bucketType, table.bucketStart, table.model, table.agentKind, table.sessionId],
    }),
    index("usage_rollup_memberships_model_bucket_index").on(
      table.model,
      table.bucketType,
      table.bucketStart,
    ),
  ],
);

export const archivedUsageEventIds = sqliteTable("archived_usage_event_ids", {
  id: text("id").primaryKey(),
  archivedAt: integer("archived_at").notNull(),
});

export const retentionState = sqliteTable("retention_state", {
  id: text("id").primaryKey(),
  error: text("error"),
  hourlyRowsDeleted: integer("hourly_rows_deleted").notNull().default(0),
  lastCompactionAt: integer("last_compaction_at"),
  rawEventsDeleted: integer("raw_events_deleted").notNull().default(0),
  rollupRowsWritten: integer("rollup_rows_written").notNull().default(0),
});
