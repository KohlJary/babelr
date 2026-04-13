CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
  "category" varchar(32) NOT NULL,
  "action" varchar(64) NOT NULL,
  "summary" text NOT NULL,
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "audit_logs_server_idx" ON "audit_logs" ("server_id");--> statement-breakpoint
CREATE INDEX "audit_logs_server_created_idx" ON "audit_logs" ("server_id", "created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" ("action");
