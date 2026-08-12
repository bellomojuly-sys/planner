ALTER TABLE `calendar_sources` ADD `access_role` text DEFAULT 'reader' NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_sources` ADD `primary` integer DEFAULT false NOT NULL;--> statement-breakpoint
DELETE FROM `calendar_sync_state`
WHERE `rowid` NOT IN (
	SELECT MAX(`rowid`)
	FROM `calendar_sync_state`
	GROUP BY `user_id`, `calendar_id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_sync_state_idx` ON `calendar_sync_state` (`user_id`,`calendar_id`);
