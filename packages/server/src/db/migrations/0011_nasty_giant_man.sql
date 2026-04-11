CREATE TABLE "server_role_assignments" (
	"server_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_role_assignments_server_id_actor_id_role_id_pk" PRIMARY KEY("server_id","actor_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "server_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"color" varchar(16),
	"position" integer DEFAULT 0 NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_role_assignments" ADD CONSTRAINT "server_role_assignments_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_role_assignments" ADD CONSTRAINT "server_role_assignments_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_role_assignments" ADD CONSTRAINT "server_role_assignments_role_id_server_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."server_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_roles" ADD CONSTRAINT "server_roles_server_id_actors_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_role_assignments_server_actor_idx" ON "server_role_assignments" USING btree ("server_id","actor_id");--> statement-breakpoint
CREATE INDEX "server_role_assignments_role_idx" ON "server_role_assignments" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_roles_server_name_idx" ON "server_roles" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "server_roles_server_idx" ON "server_roles" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "server_roles_position_idx" ON "server_roles" USING btree ("server_id","position");
--> statement-breakpoint

-- Backfill default roles for every existing server (Group actor).
-- Creates @everyone, Moderator, and Admin matching the permission
-- sets defined in packages/shared/src/permissions.ts. Keep these
-- permission arrays in sync with DEFAULT_ROLE_DEFINITIONS if the
-- shared file ever changes.

INSERT INTO "server_roles" ("server_id", "name", "color", "position", "permissions", "is_default", "is_system")
SELECT
  a.id,
  '@everyone',
  NULL,
  0,
  '["VIEW_CHANNELS","SEND_MESSAGES","ADD_REACTIONS","ATTACH_FILES","CREATE_INVITES","CONNECT_VOICE","SPEAK","VIDEO","VIEW_WIKI","CREATE_WIKI_PAGES","CREATE_EVENTS"]'::jsonb,
  true,
  true
FROM "actors" a
WHERE a.type = 'Group';
--> statement-breakpoint

INSERT INTO "server_roles" ("server_id", "name", "color", "position", "permissions", "is_default", "is_system")
SELECT
  a.id,
  'Moderator',
  '#22c55e',
  10,
  '["VIEW_CHANNELS","SEND_MESSAGES","ADD_REACTIONS","ATTACH_FILES","CREATE_INVITES","CONNECT_VOICE","SPEAK","VIDEO","VIEW_WIKI","CREATE_WIKI_PAGES","CREATE_EVENTS","MANAGE_CHANNELS","MANAGE_MESSAGES","MANAGE_WIKI","MANAGE_EVENTS","MANAGE_INVITES"]'::jsonb,
  false,
  false
FROM "actors" a
WHERE a.type = 'Group';
--> statement-breakpoint

INSERT INTO "server_roles" ("server_id", "name", "color", "position", "permissions", "is_default", "is_system")
SELECT
  a.id,
  'Admin',
  '#f59e0b',
  20,
  '["VIEW_CHANNELS","SEND_MESSAGES","ADD_REACTIONS","ATTACH_FILES","CREATE_INVITES","CONNECT_VOICE","SPEAK","VIDEO","VIEW_WIKI","CREATE_WIKI_PAGES","CREATE_EVENTS","MANAGE_CHANNELS","MANAGE_MESSAGES","MANAGE_WIKI","MANAGE_EVENTS","MANAGE_INVITES","MANAGE_SERVER","MANAGE_ROLES","KICK_MEMBERS"]'::jsonb,
  false,
  false
FROM "actors" a
WHERE a.type = 'Group';
--> statement-breakpoint

-- Assign existing members to roles based on their old
-- collection_items.properties.role string. The collection URI on
-- membership rows is the server's followersUri, so we join
-- collection_items → actors (server) via that URI, then actors
-- (member) via itemUri. Members with role='member' get no assignment
-- row (they inherit @everyone implicitly). Owner/admin both map to
-- the Admin role; moderator maps to Moderator.

INSERT INTO "server_role_assignments" ("server_id", "actor_id", "role_id")
SELECT
  server.id,
  member.id,
  role.id
FROM "collection_items" ci
INNER JOIN "actors" server
  ON server."followers_uri" = ci."collection_uri"
  AND server.type = 'Group'
INNER JOIN "actors" member
  ON member.uri = ci."item_uri"
INNER JOIN "server_roles" role
  ON role."server_id" = server.id
  AND role.name = 'Admin'
WHERE (ci.properties->>'role') IN ('owner', 'admin')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "server_role_assignments" ("server_id", "actor_id", "role_id")
SELECT
  server.id,
  member.id,
  role.id
FROM "collection_items" ci
INNER JOIN "actors" server
  ON server."followers_uri" = ci."collection_uri"
  AND server.type = 'Group'
INNER JOIN "actors" member
  ON member.uri = ci."item_uri"
INNER JOIN "server_roles" role
  ON role."server_id" = server.id
  AND role.name = 'Moderator'
WHERE (ci.properties->>'role') = 'moderator'
ON CONFLICT DO NOTHING;