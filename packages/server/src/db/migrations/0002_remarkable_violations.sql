CREATE TABLE "delivery_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_json" jsonb NOT NULL,
	"recipient_inbox_uri" text NOT NULL,
	"sender_actor_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "delivery_queue" ADD CONSTRAINT "delivery_queue_sender_actor_id_actors_id_fk" FOREIGN KEY ("sender_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_queue_pending_idx" ON "delivery_queue" USING btree ("status","next_attempt_at");