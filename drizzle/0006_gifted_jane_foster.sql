PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usage_agent_daily_rollups` (
	`local_date` text NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`model` text NOT NULL,
	`agent_kind` text NOT NULL,
	`project_id` text DEFAULT 'legacy-unknown' NOT NULL,
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
	PRIMARY KEY(`local_date`, `agent_id`, `session_id`, `model`, `agent_kind`, `project_id`)
);
--> statement-breakpoint
INSERT INTO `__new_usage_agent_daily_rollups`("local_date", "agent_id", "session_id", "model", "agent_kind", "project_id", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "request_count", "cost_usd", "unpriced_usage_count", "unpriced_input_tokens", "unpriced_cached_input_tokens", "unpriced_output_tokens") SELECT "local_date", "agent_id", "session_id", "model", "agent_kind", "project_id", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "request_count", "cost_usd", "unpriced_usage_count", "unpriced_input_tokens", "unpriced_cached_input_tokens", "unpriced_output_tokens" FROM `usage_agent_daily_rollups`;--> statement-breakpoint
DROP TABLE `usage_agent_daily_rollups`;--> statement-breakpoint
ALTER TABLE `__new_usage_agent_daily_rollups` RENAME TO `usage_agent_daily_rollups`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `usage_agent_daily_rollups_project_date_index` ON `usage_agent_daily_rollups` (`project_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `usage_agent_daily_rollups_agent_date_index` ON `usage_agent_daily_rollups` (`agent_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `__new_usage_rollup_session_memberships` (
	`bucket_type` text NOT NULL,
	`bucket_start` text NOT NULL,
	`model` text NOT NULL,
	`agent_kind` text NOT NULL,
	`project_id` text DEFAULT 'legacy-unknown' NOT NULL,
	`session_id` text NOT NULL,
	PRIMARY KEY(`bucket_type`, `bucket_start`, `model`, `agent_kind`, `project_id`, `session_id`)
);
--> statement-breakpoint
INSERT INTO `__new_usage_rollup_session_memberships`("bucket_type", "bucket_start", "model", "agent_kind", "project_id", "session_id") SELECT "bucket_type", "bucket_start", "model", "agent_kind", 'legacy-unknown', "session_id" FROM `usage_rollup_session_memberships`;--> statement-breakpoint
DROP TABLE `usage_rollup_session_memberships`;--> statement-breakpoint
ALTER TABLE `__new_usage_rollup_session_memberships` RENAME TO `usage_rollup_session_memberships`;--> statement-breakpoint
CREATE INDEX `usage_rollup_memberships_model_bucket_index` ON `usage_rollup_session_memberships` (`model`,`bucket_type`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `usage_rollup_memberships_project_bucket_index` ON `usage_rollup_session_memberships` (`project_id`,`bucket_type`,`bucket_start`);
