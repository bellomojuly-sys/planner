CREATE TABLE `plan_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`day_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_suppressions_key_idx` ON `plan_suppressions` (`user_id`,`key`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `scheduling_paused` integer DEFAULT false NOT NULL;