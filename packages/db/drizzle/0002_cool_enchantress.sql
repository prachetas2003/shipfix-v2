CREATE TABLE "worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"task_queue" text NOT NULL,
	"temporal_address" text NOT NULL,
	"temporal_namespace" text DEFAULT 'default' NOT NULL,
	"status" text DEFAULT 'polling' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb
);
