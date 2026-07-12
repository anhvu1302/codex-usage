CREATE TABLE `archived_usage_event_ids` (
	`id` text PRIMARY KEY NOT NULL,
	`archived_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `retention_state` (
	`id` text PRIMARY KEY NOT NULL,
	`error` text,
	`hourly_rows_deleted` integer DEFAULT 0 NOT NULL,
	`last_compaction_at` integer,
	`raw_events_deleted` integer DEFAULT 0 NOT NULL,
	`rollup_rows_written` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_daily_rollups` (
	`local_date` text NOT NULL,
	`model` text NOT NULL,
	`agent_kind` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_output_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`request_count` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`unpriced_usage_count` integer NOT NULL,
	`unpriced_input_tokens` integer NOT NULL,
	`unpriced_cached_input_tokens` integer NOT NULL,
	`unpriced_output_tokens` integer NOT NULL,
	PRIMARY KEY(`local_date`, `model`, `agent_kind`)
);
--> statement-breakpoint
CREATE INDEX `usage_daily_rollups_model_date_index` ON `usage_daily_rollups` (`model`,`local_date`);--> statement-breakpoint
CREATE TABLE `usage_hourly_rollups` (
	`local_date` text NOT NULL,
	`local_hour` text NOT NULL,
	`model` text NOT NULL,
	`agent_kind` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_output_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`request_count` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`unpriced_usage_count` integer NOT NULL,
	`unpriced_input_tokens` integer NOT NULL,
	`unpriced_cached_input_tokens` integer NOT NULL,
	`unpriced_output_tokens` integer NOT NULL,
	PRIMARY KEY(`local_date`, `local_hour`, `model`, `agent_kind`)
);
--> statement-breakpoint
CREATE INDEX `usage_hourly_rollups_model_date_index` ON `usage_hourly_rollups` (`model`,`local_date`);--> statement-breakpoint
CREATE TABLE `usage_rollup_session_memberships` (
	`bucket_type` text NOT NULL,
	`bucket_start` text NOT NULL,
	`model` text NOT NULL,
	`agent_kind` text NOT NULL,
	`session_id` text NOT NULL,
	PRIMARY KEY(`bucket_type`, `bucket_start`, `model`, `agent_kind`, `session_id`)
);
--> statement-breakpoint
CREATE INDEX `usage_rollup_memberships_model_bucket_index` ON `usage_rollup_session_memberships` (`model`,`bucket_type`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `usage_events_date_model_index` ON `usage_events` (`local_date`,`model`);--> statement-breakpoint
CREATE INDEX `usage_events_date_session_index` ON `usage_events` (`local_date`,`session_id`);