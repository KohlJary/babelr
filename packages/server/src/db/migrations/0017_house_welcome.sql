-- Welcoming newcomers (welcome.ts): who opted in, each welcome, guest
-- cards and their facts, and how a person arrived through an invite.
-- Idempotent, like 0012-0016.
CREATE TABLE IF NOT EXISTS "guest_card_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" text NOT NULL,
	"added_by" uuid,
	"source" varchar(200) DEFAULT 'inviter' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guest_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"label" varchar(64),
	"seeds" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invite_arrivals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"invite_id" uuid,
	"invited_by_id" uuid,
	"guest_card_id" uuid,
	"added_link" varchar(500),
	"lookup_consent" boolean,
	"consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "guest_card_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guest_card_facts_card_id_guest_cards_id_fk') THEN
  ALTER TABLE "guest_card_facts" ADD CONSTRAINT "guest_card_facts_card_id_guest_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."guest_cards"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guest_card_facts_added_by_actors_id_fk') THEN
  ALTER TABLE "guest_card_facts" ADD CONSTRAINT "guest_card_facts_added_by_actors_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guest_cards_server_id_actors_id_fk') THEN
  ALTER TABLE "guest_cards" ADD CONSTRAINT "guest_cards_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guest_cards_created_by_actors_id_fk') THEN
  ALTER TABLE "guest_cards" ADD CONSTRAINT "guest_cards_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invite_arrivals_server_id_actors_id_fk') THEN
  ALTER TABLE "invite_arrivals" ADD CONSTRAINT "invite_arrivals_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invite_arrivals_actor_id_actors_id_fk') THEN
  ALTER TABLE "invite_arrivals" ADD CONSTRAINT "invite_arrivals_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invite_arrivals_invite_id_invites_id_fk') THEN
  ALTER TABLE "invite_arrivals" ADD CONSTRAINT "invite_arrivals_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invite_arrivals_invited_by_id_actors_id_fk') THEN
  ALTER TABLE "invite_arrivals" ADD CONSTRAINT "invite_arrivals_invited_by_id_actors_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invite_arrivals_guest_card_id_guest_cards_id_fk') THEN
  ALTER TABLE "invite_arrivals" ADD CONSTRAINT "invite_arrivals_guest_card_id_guest_cards_id_fk" FOREIGN KEY ("guest_card_id") REFERENCES "public"."guest_cards"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "guest_card_facts_card_idx" ON "guest_card_facts" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_cards_server_idx" ON "guest_cards" USING btree ("server_id","created_by");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invite_arrivals_pair_idx" ON "invite_arrivals" USING btree ("server_id","actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invite_arrivals_actor_idx" ON "invite_arrivals" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "server_welcomers_pair_idx" ON "server_welcomers" USING btree ("server_id","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "welcomes_triple_idx" ON "welcomes" USING btree ("server_id","newcomer_id","welcomer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "welcomes_welcomer_state_idx" ON "welcomes" USING btree ("welcomer_id","state");--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invites_guest_card_id_guest_cards_id_fk') THEN
  ALTER TABLE "invites" ADD CONSTRAINT "invites_guest_card_id_guest_cards_id_fk" FOREIGN KEY ("guest_card_id") REFERENCES "public"."guest_cards"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;