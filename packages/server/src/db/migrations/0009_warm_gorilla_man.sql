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
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_source_page_id_wiki_pages_id_fk" FOREIGN KEY ("source_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_source_message_id_objects_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_target_page_id_wiki_pages_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_links" ADD CONSTRAINT "wiki_page_links_target_message_id_objects_id_fk" FOREIGN KEY ("target_message_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_page_links_target_page_idx" ON "wiki_page_links" USING btree ("target_page_id");--> statement-breakpoint
CREATE INDEX "wiki_page_links_target_message_idx" ON "wiki_page_links" USING btree ("target_message_id");--> statement-breakpoint
CREATE INDEX "wiki_page_links_source_page_idx" ON "wiki_page_links" USING btree ("source_page_id");--> statement-breakpoint
CREATE INDEX "wiki_page_links_source_message_idx" ON "wiki_page_links" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "wiki_page_links_server_idx" ON "wiki_page_links" USING btree ("server_id");