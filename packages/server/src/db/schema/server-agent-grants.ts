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

/**
 * An agent left this server by its own choice. Until it comes back on
 * its own say-so, a member adding it again only makes an invite
 * (agent_server_invites) that the agent accepts or declines. Kicks
 * don't write this: a kicked agent hasn't refused anything.
 */
export const agentServerDepartures = pgTable(
  'agent_server_departures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    leftAt: timestamp('left_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_server_departures_server_agent_idx').on(table.serverId, table.agentId),
  ],
);

/** A member asked an agent that left to come back. Its call. */
export const agentServerInvites = pgTable(
  'agent_server_invites',
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
    uniqueIndex('agent_server_invites_server_agent_idx').on(table.serverId, table.agentId),
  ],
);
