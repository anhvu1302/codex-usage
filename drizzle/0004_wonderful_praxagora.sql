CREATE TABLE `alert_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`scope_key` text NOT NULL,
	`period_start` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	`seen_at` integer,
	`dismissed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_events_scope_unique` ON `alert_events` (`type`,`scope_key`,`period_start`);--> statement-breakpoint
CREATE INDEX `alert_events_created_index` ON `alert_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `budget_settings` (
	`period` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`limit_usd` real DEFAULT 0 NOT NULL,
	`warning_thresholds` text DEFAULT '[50,80,100]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`display_path` text NOT NULL,
	`normalized_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_normalized_path_unique` ON `projects` (`normalized_path`);--> statement-breakpoint
CREATE TABLE `usage_agent_daily_rollups` (
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
	PRIMARY KEY(`local_date`, `agent_id`, `model`)
);
--> statement-breakpoint
CREATE INDEX `usage_agent_daily_rollups_project_date_index` ON `usage_agent_daily_rollups` (`project_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `usage_agent_daily_rollups_agent_date_index` ON `usage_agent_daily_rollups` (`agent_id`,`local_date`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usage_daily_rollups` (
	`local_date` text NOT NULL,
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
	PRIMARY KEY(`local_date`, `model`, `agent_kind`, `project_id`)
);
--> statement-breakpoint
INSERT INTO `__new_usage_daily_rollups`("local_date", "model", "agent_kind", "project_id", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "request_count", "cost_usd", "unpriced_usage_count", "unpriced_input_tokens", "unpriced_cached_input_tokens", "unpriced_output_tokens") SELECT "local_date", "model", "agent_kind", 'legacy-unknown', "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "request_count", "cost_usd", "unpriced_usage_count", "unpriced_input_tokens", "unpriced_cached_input_tokens", "unpriced_output_tokens" FROM `usage_daily_rollups`;--> statement-breakpoint
DROP TABLE `usage_daily_rollups`;--> statement-breakpoint
ALTER TABLE `__new_usage_daily_rollups` RENAME TO `usage_daily_rollups`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `usage_daily_rollups_model_date_index` ON `usage_daily_rollups` (`model`,`local_date`);--> statement-breakpoint
CREATE INDEX `usage_daily_rollups_project_date_index` ON `usage_daily_rollups` (`project_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `__new_usage_hourly_rollups` (
	`local_date` text NOT NULL,
	`local_hour` text NOT NULL,
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
	PRIMARY KEY(`local_date`, `local_hour`, `model`, `agent_kind`, `project_id`)
);
--> statement-breakpoint
INSERT INTO `__new_usage_hourly_rollups`("local_date", "local_hour", "model", "agent_kind", "project_id", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "request_count", "cost_usd", "unpriced_usage_count", "unpriced_input_tokens", "unpriced_cached_input_tokens", "unpriced_output_tokens") SELECT "local_date", "local_hour", "model", "agent_kind", 'legacy-unknown', "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "request_count", "cost_usd", "unpriced_usage_count", "unpriced_input_tokens", "unpriced_cached_input_tokens", "unpriced_output_tokens" FROM `usage_hourly_rollups`;--> statement-breakpoint
DROP TABLE `usage_hourly_rollups`;--> statement-breakpoint
ALTER TABLE `__new_usage_hourly_rollups` RENAME TO `usage_hourly_rollups`;--> statement-breakpoint
CREATE INDEX `usage_hourly_rollups_model_date_index` ON `usage_hourly_rollups` (`model`,`local_date`);--> statement-breakpoint
CREATE INDEX `usage_hourly_rollups_project_date_index` ON `usage_hourly_rollups` (`project_id`,`local_date`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `sessions_project_index` ON `sessions` (`project_id`);
