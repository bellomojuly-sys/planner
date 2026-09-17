ALTER TABLE `calendar_sources` ADD `kind` text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_sources` ADD `feed_url` text;