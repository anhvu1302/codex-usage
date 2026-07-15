CREATE TABLE `activity_daily_rollups` (
	`local_date` text NOT NULL,
	`kind` text NOT NULL,
	`agent_kind` text NOT NULL,
	`project_id` text DEFAULT 'legacy-unknown' NOT NULL,
	`event_count` integer NOT NULL,
	PRIMARY KEY(`local_date`, `kind`, `agent_kind`, `project_id`)
);
--> statement-breakpoint
CREATE INDEX `activity_daily_rollups_project_date_index` ON `activity_daily_rollups` (`project_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`timestamp` text NOT NULL,
	`local_date` text NOT NULL,
	`kind` text NOT NULL,
	`agent_kind` text NOT NULL,
	`project_id` text DEFAULT 'legacy-unknown' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `activity_events_date_index` ON `activity_events` (`local_date`);--> statement-breakpoint
CREATE INDEX `activity_events_project_date_index` ON `activity_events` (`project_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `activity_events_session_timestamp_index` ON `activity_events` (`session_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `activity_events_agent_date_index` ON `activity_events` (`agent_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `archived_activity_event_ids` (
	`id` text PRIMARY KEY NOT NULL,
	`archived_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_diagnostics` (
	`source_path` text PRIMARY KEY NOT NULL,
	`malformed_lines` integer DEFAULT 0 NOT NULL,
	`incomplete_line` integer DEFAULT false NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
