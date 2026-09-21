ALTER TABLE `settings` ADD `travel_mode` text DEFAULT 'bike' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `home_address` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `default_travel_minutes` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `travel_buffer_minutes` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `place_travel_minutes` text DEFAULT '' NOT NULL;