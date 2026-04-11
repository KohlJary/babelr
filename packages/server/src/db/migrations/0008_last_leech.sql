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
CREATE TABLE "ui_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lang" varchar(16) NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"created_by_id" uuid NOT NULL,
	"last_edited_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_actors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_id_actors_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_channel_id_objects_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_event_chat_id_objects_id_fk" FOREIGN KEY ("event_chat_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
CREATE UNIQUE INDEX "ui_translations_lang_key_idx" ON "ui_translations" USING btree ("lang","key");--> statement-breakpoint
CREATE INDEX "ui_translations_lang_idx" ON "ui_translations" USING btree ("lang");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_page_revisions_page_num_idx" ON "wiki_page_revisions" USING btree ("page_id","revision_number");--> statement-breakpoint
CREATE INDEX "wiki_page_revisions_page_idx" ON "wiki_page_revisions" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_server_slug_idx" ON "wiki_pages" USING btree ("server_id","slug");--> statement-breakpoint
CREATE INDEX "wiki_pages_server_idx" ON "wiki_pages" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "wiki_pages_updated_idx" ON "wiki_pages" USING btree ("updated_at");