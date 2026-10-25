// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

/**
 * A member with invite rights let this agent or service into this
 * server. The only way an agent joins a server: without a grant,
 * POST /servers/:id/join refuses it and its sponsor can't mint
 * `servers:join:<id>`. Kicking the agent deletes the grant.
 */
export const serverAgentGrants = pgTable(
  'server_agent_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    invitedBy: uuid('invited_by').references(() => actors.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('server_agent_grants_server_agent_idx').on(table.serverId, table.agentId),
  ],
);
