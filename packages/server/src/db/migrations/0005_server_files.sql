CREATE TABLE "server_file_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"filename" varchar(512) NOT NULL,
	"content_type" varchar(128) NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_url" text NOT NULL,
	"slug" varchar(16),
	"title" varchar(256),
	"description" text,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"folder_path" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_file_comments" ADD CONSTRAINT "server_file_comments_file_id_server_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."server_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_file_comments" ADD CONSTRAINT "server_file_comments_author_id_actors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_files" ADD CONSTRAINT "server_files_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_files" ADD CONSTRAINT "server_files_uploader_id_actors_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_file_comments_file_idx" ON "server_file_comments" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "server_files_server_idx" ON "server_files" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "server_files_folder_idx" ON "server_files" USING btree ("server_id","folder_path");--> statement-breakpoint
CREATE UNIQUE INDEX "server_files_slug_idx" ON "server_files" USING btree ("slug") WHERE "server_files"."slug" IS NOT NULL;