ALTER TABLE `scheduled_blocks` ADD `calendar_id` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `sleep_start_minutes` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `sleep_target_minutes` integer DEFAULT 480 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `wake_buffer_minutes` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `gym_max_sessions_per_week` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `gym_avoid_days` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `gym_travel_minutes` integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `gym_preparation_minutes` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `gym_return_minutes` integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `gym_min_recovery_hours` integer DEFAULT 36 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `location` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `travel_minutes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `preparation_minutes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `recovery_minutes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `flexibility` text DEFAULT 'high' NOT NULL;