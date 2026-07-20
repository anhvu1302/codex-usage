CREATE TABLE `project_budget_settings` (
	`project_id` text NOT NULL,
	`period` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`limit_usd` real DEFAULT 0 NOT NULL,
	`warning_thresholds` text DEFAULT '[50,80,100]' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `period`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_budget_settings_enabled_scan_index` ON `project_budget_settings` (`enabled`,`period`,`project_id`);