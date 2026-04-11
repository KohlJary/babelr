ALTER TABLE "wiki_pages" ADD COLUMN "tags" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "wiki_pages_tags_gin_idx" ON "wiki_pages" USING gin ("tags");