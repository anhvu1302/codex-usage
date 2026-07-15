CREATE TABLE `turn_activity_rollups` (
	`turn_key` text NOT NULL,
	`kind` text NOT NULL,
	`event_count` integer NOT NULL,
	PRIMARY KEY(`turn_key`, `kind`),
	FOREIGN KEY (`turn_key`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `turn_backfill_state` (
	`id` text PRIMARY KEY NOT NULL,
	`attribution_version` integer DEFAULT 0 NOT NULL,
	`is_running` integer DEFAULT false NOT NULL,
	`files_processed` integer DEFAULT 0 NOT NULL,
	`total_files` integer DEFAULT 0 NOT NULL,
	`source_deleted_gaps` integer DEFAULT 0 NOT NULL,
	`cost_attribution_missing_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `turn_model_usage` (
	`turn_key` text NOT NULL,
	`model` text NOT NULL,
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
	`cost_attribution_missing_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`turn_key`, `model`),
	FOREIGN KEY (`turn_key`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turn_model_usage_model_index` ON `turn_model_usage` (`model`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`project_id` text,
	`local_date` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`last_event_at` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`effort` text,
	`collaboration_mode` text,
	`model_context_window` integer,
	`duration_ms` integer,
	`time_to_first_token_ms` integer,
	`first_input_tokens` integer,
	`last_input_tokens` integer,
	`peak_input_tokens` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_id`) REFERENCES `session_agents`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_agent_turn_unique` ON `turns` (`agent_id`,`turn_id`);--> statement-breakpoint
CREATE INDEX `turns_date_index` ON `turns` (`local_date`);--> statement-breakpoint
CREATE INDEX `turns_project_date_index` ON `turns` (`project_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `turns_session_date_index` ON `turns` (`session_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `turns_agent_date_index` ON `turns` (`agent_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `turns_status_date_index` ON `turns` (`status`,`local_date`);--> statement-breakpoint
ALTER TABLE `activity_events` ADD `turn_key` text;--> statement-breakpoint
ALTER TABLE `activity_events` ADD `turn_attribution_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `alert_events` ADD `turn_key` text;--> statement-breakpoint
ALTER TABLE `archived_activity_event_ids` ADD `turn_key` text;--> statement-breakpoint
ALTER TABLE `archived_activity_event_ids` ADD `turn_attribution_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `archived_activity_turn_index` ON `archived_activity_event_ids` (`turn_key`);--> statement-breakpoint
ALTER TABLE `archived_usage_event_ids` ADD `turn_key` text;--> statement-breakpoint
ALTER TABLE `archived_usage_event_ids` ADD `turn_attribution_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `archived_usage_turn_index` ON `archived_usage_event_ids` (`turn_key`);--> statement-breakpoint
ALTER TABLE `import_states` ADD `active_turn_key` text;--> statement-breakpoint
ALTER TABLE `import_states` ADD `session_context_window` integer;--> statement-breakpoint
ALTER TABLE `import_states` ADD `turn_attribution_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `turn_key` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `turn_attribution_version` integer DEFAULT 0 NOT NULL;