CREATE TABLE `calendar_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`summary` text NOT NULL,
	`role` text DEFAULT 'ignore' NOT NULL,
	`color` text DEFAULT '#9aa3b8' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_sources_idx` ON `calendar_sources` (`user_id`,`calendar_id`);