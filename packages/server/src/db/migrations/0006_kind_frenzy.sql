ALTER TABLE "objects" ADD COLUMN "content_search" tsvector;
--> statement-breakpoint
CREATE INDEX "objects_content_search_idx" ON "objects" USING gin ("content_search");
--> statement-breakpoint
-- Populate search vector for existing objects
UPDATE "objects" SET "content_search" = to_tsvector('english', COALESCE("content", '')) WHERE "type" = 'Note';
