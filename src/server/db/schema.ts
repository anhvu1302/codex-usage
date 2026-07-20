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
    projectId: text("project_id"),
    sourcePath: text("source_path").notNull(),
    cwd: text("cwd"),
    title: text("title"),
    startedAt: text("started_at"),
    lastSeenAt: integer("last_seen_at").notNull(),
    sourceDeleted: integer("source_deleted", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("sessions_project_index").on(table.projectId),
    index("sessions_source_path_index").on(table.sourcePath),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    displayPath: text("display_path").notNull(),
    normalizedPath: text("normalized_path").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("projects_normalized_path_unique").on(table.normalizedPath)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("tags_normalized_name_unique").on(table.normalizedName)],
);

export const projectTags = sqliteTable(
  "project_tags",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.tagId] }),
    index("project_tags_tag_project_index").on(table.tagId, table.projectId),
  ],
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

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => sessionAgents.id, { onDelete: "restrict" }),
    projectId: text("project_id"),
    localDate: text("local_date").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    lastEventAt: text("last_event_at").notNull(),
    status: text("status").notNull().default("unknown"),
    effort: text("effort"),
    collaborationMode: text("collaboration_mode"),
    modelContextWindow: integer("model_context_window"),
    durationMs: integer("duration_ms"),
    timeToFirstTokenMs: integer("time_to_first_token_ms"),
    firstInputTokens: integer("first_input_tokens"),
    lastInputTokens: integer("last_input_tokens"),
    peakInputTokens: integer("peak_input_tokens"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("turns_agent_turn_unique").on(table.agentId, table.turnId),
    index("turns_date_index").on(table.localDate),
    index("turns_project_date_index").on(table.projectId, table.localDate),
    index("turns_session_date_index").on(table.sessionId, table.localDate),
    index("turns_agent_date_index").on(table.agentId, table.localDate),
    index("turns_status_date_index").on(table.status, table.localDate),
  ],
);

export const importStates = sqliteTable("import_states", {
  sourcePath: text("source_path").primaryKey(),
  lastOffset: integer("last_offset").notNull().default(0),
  sessionId: text("session_id"),
  agentId: text("agent_id"),
  dedupeVersion: integer("dedupe_version").notNull().default(0),
  activeModel: text("active_model"),
  activeTurnKey: text("active_turn_key"),
  sessionContextWindow: integer("session_context_window"),
  sourceCtimeNs: text("source_ctime_ns"),
  sourceFileId: text("source_file_id"),
  sourceMtimeNs: text("source_mtime_ns"),
  turnAttributionVersion: integer("turn_attribution_version").notNull().default(0),
  sourceSize: integer("source_size"),
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
    turnKey: text("turn_key"),
    turnAttributionVersion: integer("turn_attribution_version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("usage_events_session_hash_unique").on(table.sessionId, table.sourceHash),
    index("usage_events_local_date_index").on(table.localDate),
    index("usage_events_model_index").on(table.model),
    index("usage_events_session_index").on(table.sessionId),
    index("usage_events_agent_index").on(table.agentId),
    index("usage_events_turn_timestamp_index").on(table.turnKey, table.timestamp),
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
    projectId: text("project_id").notNull().default("legacy-unknown"),
    ...rollupFields(),
  },
  (table) => [
    primaryKey({
      columns: [table.localDate, table.localHour, table.model, table.agentKind, table.projectId],
    }),
    index("usage_hourly_rollups_model_date_index").on(table.model, table.localDate),
    index("usage_hourly_rollups_project_date_index").on(table.projectId, table.localDate),
  ],
);

export const usageDailyRollups = sqliteTable(
  "usage_daily_rollups",
  {
    localDate: text("local_date").notNull(),
    model: text("model").notNull(),
    agentKind: text("agent_kind").notNull(),
    projectId: text("project_id").notNull().default("legacy-unknown"),
    ...rollupFields(),
  },
  (table) => [
    primaryKey({ columns: [table.localDate, table.model, table.agentKind, table.projectId] }),
    index("usage_daily_rollups_model_date_index").on(table.model, table.localDate),
    index("usage_daily_rollups_project_date_index").on(table.projectId, table.localDate),
  ],
);

export const usageAgentDailyRollups = sqliteTable(
  "usage_agent_daily_rollups",
  {
    localDate: text("local_date").notNull(),
    agentId: text("agent_id").notNull(),
    sessionId: text("session_id").notNull(),
    model: text("model").notNull(),
    agentKind: text("agent_kind").notNull(),
    projectId: text("project_id").notNull().default("legacy-unknown"),
    ...rollupFields(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.localDate,
        table.agentId,
        table.sessionId,
        table.model,
        table.agentKind,
        table.projectId,
      ],
    }),
    index("usage_agent_daily_rollups_project_date_index").on(table.projectId, table.localDate),
    index("usage_agent_daily_rollups_agent_date_index").on(table.agentId, table.localDate),
  ],
);

export const usageRollupSessionMemberships = sqliteTable(
  "usage_rollup_session_memberships",
  {
    bucketType: text("bucket_type").notNull(),
    bucketStart: text("bucket_start").notNull(),
    model: text("model").notNull(),
    agentKind: text("agent_kind").notNull(),
    projectId: text("project_id").notNull().default("legacy-unknown"),
    sessionId: text("session_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.bucketType,
        table.bucketStart,
        table.model,
        table.agentKind,
        table.projectId,
        table.sessionId,
      ],
    }),
    index("usage_rollup_memberships_model_bucket_index").on(
      table.model,
      table.bucketType,
      table.bucketStart,
    ),
    index("usage_rollup_memberships_project_bucket_index").on(
      table.projectId,
      table.bucketType,
      table.bucketStart,
    ),
  ],
);

export const archivedUsageEventIds = sqliteTable(
  "archived_usage_event_ids",
  {
    id: text("id").primaryKey(),
    archivedAt: integer("archived_at").notNull(),
    turnKey: text("turn_key"),
    turnAttributionVersion: integer("turn_attribution_version").notNull().default(0),
  },
  (table) => [index("archived_usage_turn_index").on(table.turnKey)],
);

export const retentionState = sqliteTable("retention_state", {
  id: text("id").primaryKey(),
  error: text("error"),
  hourlyRowsDeleted: integer("hourly_rows_deleted").notNull().default(0),
  lastCompactionAt: integer("last_compaction_at"),
  rawEventsDeleted: integer("raw_events_deleted").notNull().default(0),
  rollupRowsWritten: integer("rollup_rows_written").notNull().default(0),
});

export const budgetSettings = sqliteTable("budget_settings", {
  period: text("period").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  limitUsd: real("limit_usd").notNull().default(0),
  warningThresholds: text("warning_thresholds").notNull().default("[50,80,100]"),
  updatedAt: integer("updated_at").notNull(),
});

export const projectBudgetSettings = sqliteTable(
  "project_budget_settings",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    limitUsd: real("limit_usd").notNull().default(0),
    warningThresholds: text("warning_thresholds").notNull().default("[50,80,100]"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.period] }),
    index("project_budget_settings_enabled_scan_index").on(
      table.enabled,
      table.period,
      table.projectId,
    ),
  ],
);

export const alertEvents = sqliteTable(
  "alert_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    scopeKey: text("scope_key").notNull(),
    periodStart: text("period_start").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    turnKey: text("turn_key"),
    createdAt: integer("created_at").notNull(),
    seenAt: integer("seen_at"),
    dismissedAt: integer("dismissed_at"),
  },
  (table) => [
    uniqueIndex("alert_events_scope_unique").on(table.type, table.scopeKey, table.periodStart),
    index("alert_events_created_index").on(table.createdAt),
  ],
);

export const turnModelUsage = sqliteTable(
  "turn_model_usage",
  {
    turnKey: text("turn_key")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    ...rollupFields(),
    costAttributionMissingCount: integer("cost_attribution_missing_count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.turnKey, table.model] }),
    index("turn_model_usage_model_index").on(table.model),
  ],
);

export const turnActivityRollups = sqliteTable(
  "turn_activity_rollups",
  {
    turnKey: text("turn_key")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    eventCount: integer("event_count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.turnKey, table.kind] })],
);

export const turnBackfillState = sqliteTable("turn_backfill_state", {
  id: text("id").primaryKey(),
  attributionVersion: integer("attribution_version").notNull().default(0),
  isRunning: integer("is_running", { mode: "boolean" }).notNull().default(false),
  filesProcessed: integer("files_processed").notNull().default(0),
  totalFiles: integer("total_files").notNull().default(0),
  sourceDeletedGaps: integer("source_deleted_gaps").notNull().default(0),
  costAttributionMissingCount: integer("cost_attribution_missing_count").notNull().default(0),
  lastRunAt: integer("last_run_at"),
  error: text("error"),
});

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    agentId: text("agent_id").notNull(),
    timestamp: text("timestamp").notNull(),
    localDate: text("local_date").notNull(),
    kind: text("kind").notNull(),
    agentKind: text("agent_kind").notNull(),
    projectId: text("project_id").notNull().default("legacy-unknown"),
    turnKey: text("turn_key"),
    turnAttributionVersion: integer("turn_attribution_version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("activity_events_date_index").on(table.localDate),
    index("activity_events_project_date_index").on(table.projectId, table.localDate),
    index("activity_events_session_timestamp_index").on(table.sessionId, table.timestamp),
    index("activity_events_agent_date_index").on(table.agentId, table.localDate),
    index("activity_events_turn_timestamp_index").on(table.turnKey, table.timestamp),
    index("activity_events_timestamp_id_index").on(table.timestamp, table.id),
  ],
);

export const activityDailyRollups = sqliteTable(
  "activity_daily_rollups",
  {
    localDate: text("local_date").notNull(),
    kind: text("kind").notNull(),
    agentKind: text("agent_kind").notNull(),
    projectId: text("project_id").notNull().default("legacy-unknown"),
    eventCount: integer("event_count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.localDate, table.kind, table.agentKind, table.projectId] }),
    index("activity_daily_rollups_project_date_index").on(table.projectId, table.localDate),
  ],
);

export const archivedActivityEventIds = sqliteTable(
  "archived_activity_event_ids",
  {
    id: text("id").primaryKey(),
    archivedAt: integer("archived_at").notNull(),
    turnKey: text("turn_key"),
    turnAttributionVersion: integer("turn_attribution_version").notNull().default(0),
  },
  (table) => [index("archived_activity_turn_index").on(table.turnKey)],
);

export const importDiagnostics = sqliteTable("import_diagnostics", {
  sourcePath: text("source_path").primaryKey(),
  malformedLines: integer("malformed_lines").notNull().default(0),
  incompleteLine: integer("incomplete_line", { mode: "boolean" }).notNull().default(false),
  lastError: text("last_error"),
  updatedAt: integer("updated_at").notNull(),
});
