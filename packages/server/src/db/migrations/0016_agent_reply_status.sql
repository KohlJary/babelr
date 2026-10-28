-- An agent's progress answering a message, and the author's retry.
-- Idempotent, like 0012-0015.
CREATE TABLE IF NOT EXISTS "agent_reply_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"state" varchar(16) NOT NULL,
	"detail" varchar(300) DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_reply_status_object_id_objects_id_fk') THEN
  ALTER TABLE "agent_reply_status" ADD CONSTRAINT "agent_reply_status_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_reply_status_agent_id_actors_id_fk') THEN
  ALTER TABLE "agent_reply_status" ADD CONSTRAINT "agent_reply_status_agent_id_actors_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_reply_status_object_agent_idx" ON "agent_reply_status" USING btree ("object_id","agent_id");
