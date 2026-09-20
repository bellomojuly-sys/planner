ALTER TABLE `settings` ADD `university_travel_minutes` integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `university_preparation_minutes` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `university_shower_preparation_minutes` integer DEFAULT 105 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `university_shower_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `restaurant_travel_minutes` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `restaurant_return_minutes` integer DEFAULT 20 NOT NULL;