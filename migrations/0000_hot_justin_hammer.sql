CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope` text DEFAULT 'capture' NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_idx` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`kind` text DEFAULT 'soft' NOT NULL,
	`is_shift` integer DEFAULT false NOT NULL,
	`etag` text,
	`cancelled` integer DEFAULT false NOT NULL,
	`content_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cal_external_idx` ON `calendar_events` (`user_id`,`calendar_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `cal_user_time_idx` ON `calendar_events` (`user_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `calendar_sync_state` (
	`user_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`sync_token` text,
	`last_synced_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`source` text DEFAULT 'action_button' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`interpretation` text,
	`applied_summary` text,
	`error` text,
	`client_request_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `captures_user_idx` ON `captures` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `captures_client_req_idx` ON `captures` (`user_id`,`client_request_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_user_provider_idx` ON `credentials` (`user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `duration_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text,
	`area` text NOT NULL,
	`energy` text NOT NULL,
	`title_sample` text,
	`estimated_minutes` integer NOT NULL,
	`actual_minutes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `samples_bucket_idx` ON `duration_samples` (`user_id`,`area`,`energy`);--> statement-breakpoint
CREATE TABLE `estimate_model` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bucket_key` text NOT NULL,
	`bias_factor` real DEFAULT 1 NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`mean_abs_error_minutes` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `estimate_bucket_idx` ON `estimate_model` (`user_id`,`bucket_key`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_key` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_runs_key_idx` ON `job_runs` (`user_id`,`job_key`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `outbox_ready_idx` ON `outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_endpoint_idx` ON `push_subscriptions` (`user_id`,`endpoint`);--> statement-breakpoint
CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`blocks_placed` integer DEFAULT 0 NOT NULL,
	`blocks_moved` integer DEFAULT 0 NOT NULL,
	`tasks_unplaced` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`error` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_user_idx` ON `schedule_runs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `scheduled_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text,
	`title` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`kind` text DEFAULT 'task' NOT NULL,
	`part_index` integer DEFAULT 0 NOT NULL,
	`part_count` integer DEFAULT 1 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`google_event_id` text,
	`sync_state` text DEFAULT 'pending' NOT NULL,
	`sync_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `blocks_user_time_idx` ON `scheduled_blocks` (`user_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `blocks_task_idx` ON `scheduled_blocks` (`task_id`);--> statement-breakpoint
CREATE INDEX `blocks_sync_idx` ON `scheduled_blocks` (`user_id`,`sync_state`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer,
	`user_agent` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`day_start_minutes` integer DEFAULT 420 NOT NULL,
	`day_end_minutes` integer DEFAULT 1350 NOT NULL,
	`morning_end_minutes` integer DEFAULT 780 NOT NULL,
	`afternoon_end_minutes` integer DEFAULT 1080 NOT NULL,
	`min_block_minutes` integer DEFAULT 20 NOT NULL,
	`max_block_minutes` integer DEFAULT 90 NOT NULL,
	`break_minutes` integer DEFAULT 10 NOT NULL,
	`buffer_around_events_minutes` integer DEFAULT 15 NOT NULL,
	`gym_sessions_per_week` integer DEFAULT 3 NOT NULL,
	`gym_duration_minutes` integer DEFAULT 75 NOT NULL,
	`gym_preferred_days` text DEFAULT '1,3,5' NOT NULL,
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
CREATE TABLE `shopping_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`unit` text DEFAULT 'pz' NOT NULL,
	`category` text DEFAULT 'altro' NOT NULL,
	`store` text,
	`url` text,
	`estimated_price` real,
	`notes` text,
	`status` text DEFAULT 'open' NOT NULL,
	`urgent` integer DEFAULT false NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shopping_user_status_idx` ON `shopping_items` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	`lag_minutes` integer DEFAULT 0 NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_dep_unique_idx` ON `task_dependencies` (`task_id`,`depends_on_id`);--> statement-breakpoint
CREATE INDEX `task_dep_reverse_idx` ON `task_dependencies` (`user_id`,`depends_on_id`);--> statement-breakpoint
CREATE TABLE `task_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'notion' NOT NULL,
	`external_id` text,
	`name` text NOT NULL,
	`area` text NOT NULL,
	`color` text DEFAULT '#7c8cf8' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`property_map` text NOT NULL,
	`last_synced_at` integer,
	`last_sync_cursor` text,
	`last_sync_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_sources_user_idx` ON `task_sources` (`user_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text,
	`external_id` text,
	`title` text NOT NULL,
	`notes` text,
	`area` text DEFAULT 'general' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` integer DEFAULT 3 NOT NULL,
	`energy` text DEFAULT 'medium' NOT NULL,
	`estimated_minutes` integer DEFAULT 30 NOT NULL,
	`planned_minutes` integer DEFAULT 30 NOT NULL,
	`actual_minutes` integer,
	`estimate_source` text DEFAULT 'claude' NOT NULL,
	`estimate_confidence` real DEFAULT 0.5 NOT NULL,
	`due_at` integer,
	`earliest_start_at` integer,
	`completed_at` integer,
	`splittable` integer DEFAULT true NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`phase_label` text,
	`phase_order` integer,
	`project_key` text,
	`is_gym` integer DEFAULT false NOT NULL,
	`dirty` integer DEFAULT false NOT NULL,
	`last_pushed_at` integer,
	`external_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `task_sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_user_status_idx` ON `tasks` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_user_due_idx` ON `tasks` (`user_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`user_id`,`project_key`,`phase_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_external_idx` ON `tasks` (`user_id`,`source_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`pin_hash` text,
	`pin_salt` text,
	`pin_iterations` integer DEFAULT 210000 NOT NULL,
	`failed_pin_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`timezone` text DEFAULT 'Europe/Rome' NOT NULL,
	`locale` text DEFAULT 'it-IT' NOT NULL,
	`plan` text DEFAULT 'personal' NOT NULL,
	`plan_status` text DEFAULT 'active' NOT NULL,
	`trial_ends_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);