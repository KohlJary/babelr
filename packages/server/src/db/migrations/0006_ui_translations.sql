CREATE TABLE "ui_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lang" varchar(16) NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ui_translations_lang_key_idx" ON "ui_translations" USING btree ("lang","key");--> statement-breakpoint
CREATE INDEX "ui_translations_lang_idx" ON "ui_translations" USING btree ("lang");
