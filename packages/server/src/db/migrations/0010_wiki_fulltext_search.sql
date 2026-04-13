ALTER TABLE "wiki_pages" ADD COLUMN "content_search" "tsvector";--> statement-breakpoint
CREATE INDEX "wiki_pages_content_search_idx" ON "wiki_pages" USING gin ("content_search");--> statement-breakpoint
-- Backfill existing pages
UPDATE "wiki_pages" SET "content_search" = to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", ''));
