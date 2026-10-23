-- DM consent (Babelr step 3d): who may message whom, message
-- requests, blocks and leaving. Idempotent, like 0012 and 0013.
CREATE TABLE IF NOT EXISTS "actor_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"allowed_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_departures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dm_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" varchar(16) DEFAULT 'left' NOT NULL,
	"left_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dm_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "dm_policy" varchar(32) DEFAULT 'anyone' NOT NULL;
--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "dm_policy_set_by" uuid;
--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "dm_policy_set_at" timestamp with time zone;
--> statement-breakpoint
-- Agents and services start at 'nobody' until their own config allows
-- DMs. Only rows nobody has set yet, so a re-run changes nothing.
UPDATE "actors" SET "dm_policy" = 'nobody' WHERE "kind" IN ('agent', 'service') AND "dm_policy_set_at" IS NULL;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'actor_blocks_blocker_id_actors_id_fk') THEN
  ALTER TABLE "actor_blocks" ADD CONSTRAINT "actor_blocks_blocker_id_actors_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'actor_blocks_blocked_id_actors_id_fk') THEN
  ALTER TABLE "actor_blocks" ADD CONSTRAINT "actor_blocks_blocked_id_actors_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dm_allowlist_owner_id_actors_id_fk') THEN
  ALTER TABLE "dm_allowlist" ADD CONSTRAINT "dm_allowlist_owner_id_actors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dm_allowlist_allowed_id_actors_id_fk') THEN
  ALTER TABLE "dm_allowlist" ADD CONSTRAINT "dm_allowlist_allowed_id_actors_id_fk" FOREIGN KEY ("allowed_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dm_allowlist_added_by_actors_id_fk') THEN
  ALTER TABLE "dm_allowlist" ADD CONSTRAINT "dm_allowlist_added_by_actors_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dm_departures_dm_id_objects_id_fk') THEN
  ALTER TABLE "dm_departures" ADD CONSTRAINT "dm_departures_dm_id_objects_id_fk" FOREIGN KEY ("dm_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dm_departures_actor_id_actors_id_fk') THEN
  ALTER TABLE "dm_departures" ADD CONSTRAINT "dm_departures_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dm_requests_dm_id_objects_id_fk') THEN
  ALTER TABLE "dm_requests" ADD CONSTRAINT "dm_requests_dm_id_objects_id_fk" FOREIGN KEY ("dm_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dm_requests_from_id_actors_id_fk') THEN
  ALTER TABLE "dm_requests" ADD CONSTRAINT "dm_requests_from_id_actors_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dm_requests_to_id_actors_id_fk') THEN
  ALTER TABLE "dm_requests" ADD CONSTRAINT "dm_requests_to_id_actors_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'actors_dm_policy_set_by_actors_id_fk') THEN
  ALTER TABLE "actors" ADD CONSTRAINT "actors_dm_policy_set_by_actors_id_fk" FOREIGN KEY ("dm_policy_set_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "actor_blocks_pair_idx" ON "actor_blocks" USING btree ("blocker_id","blocked_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actor_blocks_blocked_idx" ON "actor_blocks" USING btree ("blocked_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_allowlist_pair_idx" ON "dm_allowlist" USING btree ("owner_id","allowed_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_departures_dm_actor_idx" ON "dm_departures" USING btree ("dm_id","actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_departures_actor_idx" ON "dm_departures" USING btree ("actor_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_requests_pair_idx" ON "dm_requests" USING btree ("from_id","to_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_requests_to_state_idx" ON "dm_requests" USING btree ("to_id","state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_requests_dm_idx" ON "dm_requests" USING btree ("dm_id");
