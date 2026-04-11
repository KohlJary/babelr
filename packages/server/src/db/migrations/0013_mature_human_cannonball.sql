-- Drizzle re-emitted the objects_slug_idx as a spurious diff from
-- a stale snapshot; drop/recreate is a no-op on real DB state.
DROP INDEX IF EXISTS "objects_slug_idx";
--> statement-breakpoint

ALTER TABLE "events" ADD COLUMN "slug" varchar(16);
--> statement-breakpoint

-- Backfill existing events with slugs before enforcing uniqueness.
-- Same Crockford-ish alphabet as messages so the two namespaces
-- draw from the same pool, and a bounded retry loop handles the
-- (vanishingly unlikely) collision case.
DO $$
DECLARE
  ev RECORD;
  new_slug text;
  alphabet text := 'abcdefghjkmnpqrstuvwxyz23456789';
  i int;
  attempts int;
BEGIN
  FOR ev IN SELECT id FROM events WHERE slug IS NULL LOOP
    attempts := 0;
    LOOP
      new_slug := '';
      FOR i IN 1..10 LOOP
        new_slug := new_slug || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      END LOOP;
      BEGIN
        UPDATE events SET slug = new_slug WHERE id = ev.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        attempts := attempts + 1;
        IF attempts > 10 THEN
          RAISE EXCEPTION 'Failed to generate unique slug for event % after 10 attempts', ev.id;
        END IF;
      END;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX "events_slug_idx" ON "events" ("slug") WHERE slug IS NOT NULL;
--> statement-breakpoint

-- Recreate the objects_slug_idx that drizzle dropped above. No
-- state change since the backfill for message slugs already ran
-- in migration 0012.
CREATE UNIQUE INDEX "objects_slug_idx" ON "objects" ("slug") WHERE slug IS NOT NULL;
