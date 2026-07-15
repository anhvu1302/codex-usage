CREATE TABLE `__repaired_usage_rollup_session_memberships` (
	`bucket_type` text NOT NULL,
	`bucket_start` text NOT NULL,
	`model` text NOT NULL,
	`agent_kind` text NOT NULL,
	`project_id` text DEFAULT 'legacy-unknown' NOT NULL,
	`session_id` text NOT NULL,
	PRIMARY KEY(`bucket_type`, `bucket_start`, `model`, `agent_kind`, `project_id`, `session_id`)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `__repaired_usage_rollup_session_memberships`
	(`bucket_type`, `bucket_start`, `model`, `agent_kind`, `project_id`, `session_id`)
SELECT
	memberships.`bucket_type`,
	memberships.`bucket_start`,
	memberships.`model`,
	memberships.`agent_kind`,
	CASE
		WHEN memberships.`project_id` <> 'legacy-unknown' THEN memberships.`project_id`
		ELSE coalesce(agent_usage.`project_id`, memberships.`project_id`)
	END,
	memberships.`session_id`
FROM `usage_rollup_session_memberships` AS memberships
LEFT JOIN (
	SELECT DISTINCT
		`local_date`,
		`session_id`,
		`model`,
		`agent_kind`,
		`project_id`
	FROM `usage_agent_daily_rollups`
	WHERE `project_id` <> 'legacy-unknown'
) AS agent_usage ON
	agent_usage.`local_date` = substr(memberships.`bucket_start`, 1, 10)
	AND agent_usage.`session_id` = memberships.`session_id`
	AND agent_usage.`model` = memberships.`model`
	AND agent_usage.`agent_kind` = memberships.`agent_kind`;
--> statement-breakpoint
DROP TABLE `usage_rollup_session_memberships`;
--> statement-breakpoint
ALTER TABLE `__repaired_usage_rollup_session_memberships`
RENAME TO `usage_rollup_session_memberships`;
--> statement-breakpoint
CREATE INDEX `usage_rollup_memberships_model_bucket_index`
ON `usage_rollup_session_memberships` (`model`, `bucket_type`, `bucket_start`);
--> statement-breakpoint
CREATE INDEX `usage_rollup_memberships_project_bucket_index`
ON `usage_rollup_session_memberships` (`project_id`, `bucket_type`, `bucket_start`);
