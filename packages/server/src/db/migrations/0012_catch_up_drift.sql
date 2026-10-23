-- Catch-up migration: schema that was added to the Drizzle models (and
-- applied to dev databases with `drizzle-kit push`) but never got a
-- migration. Everything here is idempotent so it is safe on a database
-- that already has these objects (e.g. one built with `push`).
--
-- audit_logs and wiki_pages.content_search are NOT here: 0010 and 0011
-- already create them. The 0012 snapshot is the first since 0009, so it
-- records them too.
CREATE TABLE IF NOT EXISTS "pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_type" varchar(32) DEFAULT 'message' NOT NULL,
	"pinned_by" uuid NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "server_bans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"banned_by" uuid NOT NULL,
	"reason" text,
	"banned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "verification_token" text;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "verification_token_expires" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "totp_secret" text;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "totp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "totp_recovery_codes" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
-- Foreign keys, named as drizzle names them (<table>_<col>_actors_id_fk).
-- Databases whose tables were created by hand-written SQL (0011's
-- audit_logs, and the pins/push/bans tables on some dev DBs) have the
-- same FK under Postgres's default name <table>_<col>_fkey: rename it
-- rather than add a duplicate. Otherwise add it if it's missing.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pins'::regclass AND conname = 'pins_pinned_by_actors_id_fk') THEN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pins'::regclass AND conname = 'pins_pinned_by_fkey') THEN
   ALTER TABLE "pins" RENAME CONSTRAINT "pins_pinned_by_fkey" TO "pins_pinned_by_actors_id_fk";
  ELSE
   ALTER TABLE "pins" ADD CONSTRAINT "pins_pinned_by_actors_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;
  END IF;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.push_subscriptions'::regclass AND conname = 'push_subscriptions_actor_id_actors_id_fk') THEN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.push_subscriptions'::regclass AND conname = 'push_subscriptions_actor_id_fkey') THEN
   ALTER TABLE "push_subscriptions" RENAME CONSTRAINT "push_subscriptions_actor_id_fkey" TO "push_subscriptions_actor_id_actors_id_fk";
  ELSE
   ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.server_bans'::regclass AND conname = 'server_bans_server_id_actors_id_fk') THEN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.server_bans'::regclass AND conname = 'server_bans_server_id_fkey') THEN
   ALTER TABLE "server_bans" RENAME CONSTRAINT "server_bans_server_id_fkey" TO "server_bans_server_id_actors_id_fk";
  ELSE
   ALTER TABLE "server_bans" ADD CONSTRAINT "server_bans_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.server_bans'::regclass AND conname = 'server_bans_user_id_actors_id_fk') THEN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.server_bans'::regclass AND conname = 'server_bans_user_id_fkey') THEN
   ALTER TABLE "server_bans" RENAME CONSTRAINT "server_bans_user_id_fkey" TO "server_bans_user_id_actors_id_fk";
  ELSE
   ALTER TABLE "server_bans" ADD CONSTRAINT "server_bans_user_id_actors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.server_bans'::regclass AND conname = 'server_bans_banned_by_actors_id_fk') THEN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.server_bans'::regclass AND conname = 'server_bans_banned_by_fkey') THEN
   ALTER TABLE "server_bans" RENAME CONSTRAINT "server_bans_banned_by_fkey" TO "server_bans_banned_by_actors_id_fk";
  ELSE
   ALTER TABLE "server_bans" ADD CONSTRAINT "server_bans_banned_by_actors_id_fk" FOREIGN KEY ("banned_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;
  END IF;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.audit_logs'::regclass AND conname = 'audit_logs_server_id_actors_id_fk') THEN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.audit_logs'::regclass AND conname = 'audit_logs_server_id_fkey') THEN
   ALTER TABLE "audit_logs" RENAME CONSTRAINT "audit_logs_server_id_fkey" TO "audit_logs_server_id_actors_id_fk";
  ELSE
   ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.audit_logs'::regclass AND conname = 'audit_logs_actor_id_actors_id_fk') THEN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.audit_logs'::regclass AND conname = 'audit_logs_actor_id_fkey') THEN
   ALTER TABLE "audit_logs" RENAME CONSTRAINT "audit_logs_actor_id_fkey" TO "audit_logs_actor_id_actors_id_fk";
  ELSE
   ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
 END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pins_context_target_idx" ON "pins" USING btree ("context_id","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subs_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "server_bans_server_user_idx" ON "server_bans" USING btree ("server_id","user_id");
