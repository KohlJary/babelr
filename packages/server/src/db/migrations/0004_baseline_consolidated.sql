CREATE TABLE "event_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uri" varchar(512) NOT NULL,
	"owner_type" varchar(16) NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"slug" varchar(16),
	"title" varchar(256) NOT NULL,
	"description" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"location" text,
	"rrule" text,
	"channel_id" uuid,
	"event_chat_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_uri_unique" UNIQUE("uri")
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_actor_id" uuid NOT NULL,
	"other_actor_id" uuid NOT NULL,
	"state" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"server_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_type" varchar(16) NOT NULL,
	"muted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"emoji" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "read_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_role_assignments" (
	"server_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_role_assignments_server_id_actor_id_role_id_pk" PRIMARY KEY("server_id","actor_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "server_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"color" varchar(16),
	"position" integer DEFAULT 0 NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ui_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lang" varchar(16) NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_page_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"source_type" varchar(16) NOT NULL,
	"source_page_id" uuid,
	"source_message_id" uuid,
	"target_type" varchar(16) NOT NULL,
	"target_page_id" uuid,
	"target_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_page_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"title" varchar(256) NOT NULL,
	"content" text NOT NULL,
	"edited_by_id" uuid NOT NULL,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"title" varchar(256) NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by_id" uuid NOT NULL,
	"last_edited_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "slug" varchar(16);--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "content_search" "tsvector";--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_actors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_id_actors_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_channel_id_objects_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_event_chat_id_objects_id_fk" FOREIGN KEY ("event_chat_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_owner_actor_id_actors_id_fk" FOREIGN KEY ("owner_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_other_actor_id_actors_id_fk" FOREIGN KEY ("other_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_positions" ADD CONSTRAINT "read_positions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_positions" ADD CONSTRAINT "read_positions_channel_id_objects_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_role_assignments" ADD CONSTRAINT "server_role_assignments_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_role_assignments" ADD CONSTRAINT "server_role_assignments_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_role_assignments" ADD CONSTRAINT "server_role_assignments_role_id_server_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."server_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_roles" ADD CONSTRAINT "server_roles_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_source_page_id_wiki_pages_id_fk" FOREIGN KEY ("source_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_source_message_id_objects_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_target_page_id_wiki_pages_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_target_message_id_objects_id_fk" FOREIGN KEY ("target_message_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_revisions" ADD CONSTRAINT "wiki_page_revisions_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_revisions" ADD CONSTRAINT "wiki_page_revisions_edited_by_id_actors_id_fk" FOREIGN KEY ("edited_by_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_created_by_id_actors_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_last_edited_by_id_actors_id_fk" FOREIGN KEY ("last_edited_by_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_event_actor_idx" ON "event_attendees" USING btree ("event_id","actor_id");--> statement-breakpoint
CREATE INDEX "event_attendees_actor_idx" ON "event_attendees" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "events_owner_idx" ON "events" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "events_start_at_idx" ON "events" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "events_channel_idx" ON "events" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_slug_idx" ON "events" USING btree ("slug") WHERE "events"."slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "friendships_owner_other_idx" ON "friendships" USING btree ("owner_actor_id","other_actor_id");--> statement-breakpoint
CREATE INDEX "friendships_owner_idx" ON "friendships" USING btree ("owner_actor_id");--> statement-breakpoint
CREATE INDEX "friendships_state_idx" ON "friendships" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_prefs_unique_idx" ON "notification_preferences" USING btree ("actor_id","target_id");--> statement-breakpoint
CREATE INDEX "reactions_object_id_idx" ON "reactions" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "reactions_actor_id_idx" ON "reactions" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "read_positions_actor_channel_idx" ON "read_positions" USING btree ("actor_id","channel_id");--> statement-breakpoint
CREATE INDEX "server_role_assignments_server_actor_idx" ON "server_role_assignments" USING btree ("server_id","actor_id");--> statement-breakpoint
CREATE INDEX "server_role_assignments_role_idx" ON "server_role_assignments" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_roles_server_name_idx" ON "server_roles" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "server_roles_server_idx" ON "server_roles" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "server_roles_position_idx" ON "server_roles" USING btree ("server_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ui_translations_lang_key_idx" ON "ui_translations" USING btree ("lang","key");--> statement-breakpoint
CREATE INDEX "ui_translations_lang_idx" ON "ui_translations" USING btree ("lang");--> statement-breakpoint
CREATE INDEX "wiki_page_links_target_page_idx" ON "wiki_page_links" USING btree ("target_page_id");--> statement-breakpoint
CREATE INDEX "wiki_page_links_target_message_idx" ON "wiki_page_links" USING btree ("target_message_id");--> statement-breakpoint
CREATE INDEX "wiki_page_links_source_page_idx" ON "wiki_page_links" USING btree ("source_page_id");--> statement-breakpoint
CREATE INDEX "wiki_page_links_source_message_idx" ON "wiki_page_links" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "wiki_page_links_server_idx" ON "wiki_page_links" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_page_revisions_page_num_idx" ON "wiki_page_revisions" USING btree ("page_id","revision_number");--> statement-breakpoint
CREATE INDEX "wiki_page_revisions_page_idx" ON "wiki_page_revisions" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_server_slug_idx" ON "wiki_pages" USING btree ("server_id","slug");--> statement-breakpoint
CREATE INDEX "wiki_pages_server_idx" ON "wiki_pages" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "wiki_pages_updated_idx" ON "wiki_pages" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "wiki_pages_tags_gin_idx" ON "wiki_pages" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "objects_slug_idx" ON "objects" USING btree ("slug") WHERE "objects"."slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "objects_content_search_idx" ON "objects" USING gin ("content_search");