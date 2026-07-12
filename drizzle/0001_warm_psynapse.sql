CREATE TABLE `session_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`source_path` text NOT NULL,
	`thread_source` text NOT NULL,
	`parent_thread_id` text,
	`name` text,
	`role` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`task_summary` text,
	`last_seen_at` integer NOT NULL,
	`source_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `session_agents_session_index` ON `session_agents` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_agents_source_path_index` ON `session_agents` (`source_path`);--> statement-breakpoint
ALTER TABLE `import_states` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `title` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `agent_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `usage_events_agent_index` ON `usage_events` (`agent_id`);