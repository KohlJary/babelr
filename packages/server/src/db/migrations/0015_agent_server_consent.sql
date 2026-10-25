-- An agent that left a server comes back only on its own say-so
-- (Babelr step 3d). Idempotent, like 0012-0014.
CREATE TABLE IF NOT EXISTS "agent_server_departures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"left_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_server_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_server_departures_server_id_actors_id_fk') THEN
  ALTER TABLE "agent_server_departures" ADD CONSTRAINT "agent_server_departures_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_server_departures_agent_id_actors_id_fk') THEN
  ALTER TABLE "agent_server_departures" ADD CONSTRAINT "agent_server_departures_agent_id_actors_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_server_invites_server_id_actors_id_fk') THEN
  ALTER TABLE "agent_server_invites" ADD CONSTRAINT "agent_server_invites_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_server_invites_agent_id_actors_id_fk') THEN
  ALTER TABLE "agent_server_invites" ADD CONSTRAINT "agent_server_invites_agent_id_actors_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_server_invites_invited_by_actors_id_fk') THEN
  ALTER TABLE "agent_server_invites" ADD CONSTRAINT "agent_server_invites_invited_by_actors_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_server_departures_server_agent_idx" ON "agent_server_departures" USING btree ("server_id","agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_server_invites_server_agent_idx" ON "agent_server_invites" USING btree ("server_id","agent_id");
