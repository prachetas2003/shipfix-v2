ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "auto_deploy_on_push" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "github_installation_id" text;
