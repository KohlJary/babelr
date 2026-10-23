-- Agent and service accounts (Babelr step 3c). Idempotent, like 0012,
-- so it is safe on databases built with `drizzle-kit push`.
CREATE TABLE IF NOT EXISTS "agent_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
-- Account-level audit rows (agent requests, agent management) have no server.
ALTER TABLE "audit_logs" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "kind" varchar(16) DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "sponsor_id" uuid;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "suspended_by" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "sponsor_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "scope" varchar(128);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "route" text;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_tokens_actor_id_actors_id_fk') THEN
  ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_tokens_created_by_actors_id_fk') THEN
  ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_tokens_revoked_by_actors_id_fk') THEN
  ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_revoked_by_actors_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'actors_sponsor_id_actors_id_fk') THEN
  ALTER TABLE "actors" ADD CONSTRAINT "actors_sponsor_id_actors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'actors_suspended_by_actors_id_fk') THEN
  ALTER TABLE "actors" ADD CONSTRAINT "actors_suspended_by_actors_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_sponsor_id_actors_id_fk') THEN
  ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_sponsor_id_actors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tokens_actor_idx" ON "agent_tokens" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actors_sponsor_idx" ON "actors" USING btree ("sponsor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_sponsor_created_idx" ON "audit_logs" USING btree ("sponsor_id","created_at");
