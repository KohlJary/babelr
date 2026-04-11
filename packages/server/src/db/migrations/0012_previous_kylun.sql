ALTER TABLE "objects" ADD COLUMN "slug" varchar(16);
--> statement-breakpoint

-- Backfill existing Notes with slugs before enforcing uniqueness.
-- Uses the same 31-char Crockford-ish alphabet as the application's
-- generateMessageSlug() helper so the space is consistent. Loops
-- per-row and retries on the (vanishingly unlikely) collision case.
DO $$
DECLARE
  msg RECORD;
  new_slug text;
  alphabet text := 'abcdefghjkmnpqrstuvwxyz23456789';
  i int;
  attempts int;
BEGIN
  FOR msg IN SELECT id FROM objects WHERE type = 'Note' AND slug IS NULL LOOP
    attempts := 0;
    LOOP
      new_slug := '';
      FOR i IN 1..10 LOOP
        new_slug := new_slug || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      END LOOP;
      BEGIN
        UPDATE objects SET slug = new_slug WHERE id = msg.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        attempts := attempts + 1;
        IF attempts > 10 THEN
          RAISE EXCEPTION 'Failed to generate unique slug for message % after 10 attempts', msg.id;
        END IF;
      END;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint

-- Partial unique index — only enforced where slug is set. Channels,
-- activities, and other non-Note rows keep slug NULL and are
-- unaffected. The `WHERE slug IS NOT NULL` predicate is what makes
-- this partial.
CREATE UNIQUE INDEX "objects_slug_idx" ON "objects" ("slug") WHERE slug IS NOT NULL;
