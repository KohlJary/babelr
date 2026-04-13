ALTER TABLE "wiki_pages" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "wiki_pages_parent_idx" ON "wiki_pages" USING btree ("parent_id");