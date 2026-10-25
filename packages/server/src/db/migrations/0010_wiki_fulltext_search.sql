-- Idempotent (IF NOT EXISTS), so it is safe on a database that already has
-- these objects but never recorded this migration (built with `push`).
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "content_search" "tsvector";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_pages_content_search_idx" ON "wiki_pages" USING gin ("content_search");--> statement-breakpoint
-- Backfill existing pages
UPDATE "wiki_pages" SET "content_search" = to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", ''));
