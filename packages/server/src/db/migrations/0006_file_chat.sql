ALTER TABLE "server_file_comments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "server_file_comments" CASCADE;--> statement-breakpoint
ALTER TABLE "server_files" ADD COLUMN "chat_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "server_files" ADD CONSTRAINT "server_files_chat_id_objects_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;