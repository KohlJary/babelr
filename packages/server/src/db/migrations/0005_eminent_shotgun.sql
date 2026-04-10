CREATE TABLE "friendships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_actor_id" uuid NOT NULL,
	"other_actor_id" uuid NOT NULL,
	"state" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_owner_actor_id_actors_id_fk" FOREIGN KEY ("owner_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_other_actor_id_actors_id_fk" FOREIGN KEY ("other_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "friendships_owner_other_idx" ON "friendships" USING btree ("owner_actor_id","other_actor_id");--> statement-breakpoint
CREATE INDEX "friendships_owner_idx" ON "friendships" USING btree ("owner_actor_id");--> statement-breakpoint
CREATE INDEX "friendships_state_idx" ON "friendships" USING btree ("state");
