PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`day_start_minutes` integer DEFAULT 420 NOT NULL,
	`day_end_minutes` integer DEFAULT 1350 NOT NULL,
	`sleep_start_minutes` integer DEFAULT 60 NOT NULL,
	`sleep_target_minutes` integer DEFAULT 480 NOT NULL,
	`wake_buffer_minutes` integer DEFAULT 30 NOT NULL,
	`morning_end_minutes` integer DEFAULT 780 NOT NULL,
	`afternoon_end_minutes` integer DEFAULT 1080 NOT NULL,
	`min_block_minutes` integer DEFAULT 20 NOT NULL,
	`max_block_minutes` integer DEFAULT 90 NOT NULL,
	`break_minutes` integer DEFAULT 10 NOT NULL,
	`buffer_around_events_minutes` integer DEFAULT 15 NOT NULL,
	`university_travel_minutes` integer DEFAULT 20 NOT NULL,
	`university_to_work_travel_minutes` integer DEFAULT 25 NOT NULL,
	`university_preparation_minutes` integer DEFAULT 60 NOT NULL,
	`university_shower_preparation_minutes` integer DEFAULT 105 NOT NULL,
	`university_shower_default` integer DEFAULT false NOT NULL,
	`restaurant_travel_minutes` integer DEFAULT 20 NOT NULL,
	`restaurant_return_minutes` integer DEFAULT 20 NOT NULL,
	`gym_sessions_per_week` integer DEFAULT 3 NOT NULL,
	`gym_max_sessions_per_week` integer DEFAULT 4 NOT NULL,
	`gym_duration_minutes` integer DEFAULT 75 NOT NULL,
	`gym_preferred_days` text DEFAULT '1,3,5' NOT NULL,
	`gym_avoid_days` text DEFAULT '' NOT NULL,
	`gym_travel_minutes` integer DEFAULT 25 NOT NULL,
	`gym_preparation_minutes` integer DEFAULT 20 NOT NULL,
	`gym_return_minutes` integer DEFAULT 25 NOT NULL,
	`gym_min_recovery_hours` integer DEFAULT 36 NOT NULL,
	`briefing_minutes` integer DEFAULT 420 NOT NULL,
	`review_minutes` integer DEFAULT 1230 NOT NULL,
	`review_after_shift_minutes` integer DEFAULT 30 NOT NULL,
	`fixed_event_keywords` text DEFAULT 'turno,ristorante,lezione,esame,shift,lesson' NOT NULL,
	`planning_horizon_days` integer DEFAULT 14 NOT NULL,
	`auto_reschedule_enabled` integer DEFAULT true NOT NULL,
	`push_enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_settings`("user_id", "day_start_minutes", "day_end_minutes", "sleep_start_minutes", "sleep_target_minutes", "wake_buffer_minutes", "morning_end_minutes", "afternoon_end_minutes", "min_block_minutes", "max_block_minutes", "break_minutes", "buffer_around_events_minutes", "university_travel_minutes", "university_to_work_travel_minutes", "university_preparation_minutes", "university_shower_preparation_minutes", "university_shower_default", "restaurant_travel_minutes", "restaurant_return_minutes", "gym_sessions_per_week", "gym_max_sessions_per_week", "gym_duration_minutes", "gym_preferred_days", "gym_avoid_days", "gym_travel_minutes", "gym_preparation_minutes", "gym_return_minutes", "gym_min_recovery_hours", "briefing_minutes", "review_minutes", "review_after_shift_minutes", "fixed_event_keywords", "planning_horizon_days", "auto_reschedule_enabled", "push_enabled", "updated_at") SELECT "user_id", "day_start_minutes", "day_end_minutes", "sleep_start_minutes", "sleep_target_minutes", "wake_buffer_minutes", "morning_end_minutes", "afternoon_end_minutes", "min_block_minutes", "max_block_minutes", "break_minutes", "buffer_around_events_minutes", MAX("university_travel_minutes", 20), 25, "university_preparation_minutes", "university_shower_preparation_minutes", "university_shower_default", "restaurant_travel_minutes", "restaurant_return_minutes", "gym_sessions_per_week", "gym_max_sessions_per_week", "gym_duration_minutes", "gym_preferred_days", "gym_avoid_days", "gym_travel_minutes", "gym_preparation_minutes", "gym_return_minutes", "gym_min_recovery_hours", "briefing_minutes", "review_minutes", "review_after_shift_minutes", "fixed_event_keywords", "planning_horizon_days", "auto_reschedule_enabled", "push_enabled", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
