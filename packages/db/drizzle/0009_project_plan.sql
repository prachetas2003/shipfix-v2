ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "plan" text DEFAULT 'free' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "subscription_status" text;
