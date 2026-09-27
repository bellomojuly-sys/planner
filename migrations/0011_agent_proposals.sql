CREATE TABLE `agent_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`domain_agent` text NOT NULL,
	`payload` text NOT NULL,
	`proposal_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`committed_at` integer,
	`created_task_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_proposals_user_status_idx` ON `agent_proposals` (`user_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `agent_proposals_user_hash_idx` ON `agent_proposals` (`user_id`,`proposal_hash`);
