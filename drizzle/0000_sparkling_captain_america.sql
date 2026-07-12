CREATE TABLE `import_states` (
	`source_path` text PRIMARY KEY NOT NULL,
	`last_offset` integer DEFAULT 0 NOT NULL,
	`session_id` text,
	`active_model` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_rates` (
	`model` text PRIMARY KEY NOT NULL,
	`input_rate` real NOT NULL,
	`cached_input_rate` real NOT NULL,
	`output_rate` real NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_path` text NOT NULL,
	`cwd` text,
	`started_at` text,
	`last_seen_at` integer NOT NULL,
	`source_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_source_path_index` ON `sessions` (`source_path`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`timestamp` text NOT NULL,
	`local_date` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_output_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`input_rate` real,
	`cached_input_rate` real,
	`output_rate` real,
	`cost_usd` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_session_hash_unique` ON `usage_events` (`session_id`,`source_hash`);--> statement-breakpoint
CREATE INDEX `usage_events_local_date_index` ON `usage_events` (`local_date`);--> statement-breakpoint
CREATE INDEX `usage_events_model_index` ON `usage_events` (`model`);--> statement-breakpoint
CREATE INDEX `usage_events_session_index` ON `usage_events` (`session_id`);