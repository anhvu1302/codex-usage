import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  ],
);
