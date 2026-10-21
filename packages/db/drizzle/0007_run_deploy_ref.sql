ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "deploy_branch" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "deploy_sha" text;
