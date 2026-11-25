-- Welcoming newcomers: who opted in, and each welcome (welcome.ts).
-- Idempotent, like 0012-0016.
CREATE TABLE IF NOT EXISTS "server_welcomers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "welcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"newcomer_id" uuid NOT NULL,
	"welcomer_id" uuid NOT NULL,
	"dm_id" uuid,
	"invited_by_id" uuid,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"reason" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'server_welcomers_server_id_actors_id_fk') THEN
  ALTER TABLE "server_welcomers" ADD CONSTRAINT "server_welcomers_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'server_welcomers_actor_id_actors_id_fk') THEN
  ALTER TABLE "server_welcomers" ADD CONSTRAINT "server_welcomers_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welcomes_server_id_actors_id_fk') THEN
  ALTER TABLE "welcomes" ADD CONSTRAINT "welcomes_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welcomes_newcomer_id_actors_id_fk') THEN
  ALTER TABLE "welcomes" ADD CONSTRAINT "welcomes_newcomer_id_actors_id_fk" FOREIGN KEY ("newcomer_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welcomes_welcomer_id_actors_id_fk') THEN
  ALTER TABLE "welcomes" ADD CONSTRAINT "welcomes_welcomer_id_actors_id_fk" FOREIGN KEY ("welcomer_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welcomes_dm_id_objects_id_fk') THEN
  ALTER TABLE "welcomes" ADD CONSTRAINT "welcomes_dm_id_objects_id_fk" FOREIGN KEY ("dm_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welcomes_invited_by_id_actors_id_fk') THEN
  ALTER TABLE "welcomes" ADD CONSTRAINT "welcomes_invited_by_id_actors_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "server_welcomers_pair_idx" ON "server_welcomers" USING btree ("server_id","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "welcomes_triple_idx" ON "welcomes" USING btree ("server_id","newcomer_id","welcomer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "welcomes_welcomer_state_idx" ON "welcomes" USING btree ("welcomer_id","state");