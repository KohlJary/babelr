CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uri" text NOT NULL,
	"type" varchar(32) NOT NULL,
	"actor_id" uuid NOT NULL,
	"object_uri" text NOT NULL,
	"object_id" uuid,
	"target_uri" text,
	"to" jsonb DEFAULT '[]'::jsonb,
	"cc" jsonb DEFAULT '[]'::jsonb,
	"properties" jsonb DEFAULT '{}'::jsonb,
	"published" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_uri_unique" UNIQUE("uri")
);
--> statement-breakpoint
CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uri" text NOT NULL,
	"type" varchar(32) DEFAULT 'Person' NOT NULL,
	"preferred_username" varchar(64) NOT NULL,
	"display_name" varchar(128),
	"summary" text,
	"email" varchar(256),
	"password_hash" text,
	"inbox_uri" text NOT NULL,
	"outbox_uri" text NOT NULL,
	"followers_uri" text,
	"following_uri" text,
	"preferred_language" varchar(16) DEFAULT 'en',
	"properties" jsonb DEFAULT '{}'::jsonb,
	"local" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actors_uri_unique" UNIQUE("uri")
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_uri" text NOT NULL,
	"collection_id" uuid,
	"item_uri" text NOT NULL,
	"item_id" uuid,
	"position" integer,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uri" text NOT NULL,
	"type" varchar(64) NOT NULL,
	"attributed_to" uuid,
	"content" text,
	"content_map" jsonb,
	"media_type" varchar(64) DEFAULT 'text/plain',
	"source" jsonb,
	"in_reply_to" uuid,
	"context" uuid,
	"to" jsonb DEFAULT '[]'::jsonb,
	"cc" jsonb DEFAULT '[]'::jsonb,
	"belongs_to" uuid,
	"properties" jsonb DEFAULT '{}'::jsonb,
	"published" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone,
	CONSTRAINT "objects_uri_unique" UNIQUE("uri")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar(255) PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_objects_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_attributed_to_actors_id_fk" FOREIGN KEY ("attributed_to") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_belongs_to_actors_id_fk" FOREIGN KEY ("belongs_to") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_actor_id_published_idx" ON "activities" USING btree ("actor_id","published");--> statement-breakpoint
CREATE INDEX "activities_object_id_idx" ON "activities" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actors_preferred_username_local_idx" ON "actors" USING btree ("preferred_username") WHERE "actors"."local" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_items_unique_idx" ON "collection_items" USING btree ("collection_uri","item_uri");--> statement-breakpoint
CREATE INDEX "collection_items_collection_position_idx" ON "collection_items" USING btree ("collection_uri","position");--> statement-breakpoint
CREATE INDEX "objects_context_published_idx" ON "objects" USING btree ("context","published");--> statement-breakpoint
CREATE INDEX "objects_attributed_to_published_idx" ON "objects" USING btree ("attributed_to","published");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");