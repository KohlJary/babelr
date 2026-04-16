// SPDX-License-Identifier: Hippocratic-3.0
import type { WsServerMessage } from '@babelr/shared';

/**
 * Module augmentation mirroring packages/server/src/types.ts. Plugin
 * authors import from @babelr/plugin-sdk, which transitively pulls this
 * declaration in, so `fastify.db`, `request.actor`, `fastify.broadcast*`
 * etc. have proper types without the plugin having to reach into the
 * server package.
 *
 * Kept in sync with the server's augmentation manually. If the server
 * ever adds a decorator the SDK should expose, add it here as well.
 * The types are deliberately loose on third-party-reachable internals —
 * plugins should reach for the narrower public interface we expose, not
 * for internal server shapes.
 */

declare module 'fastify' {
  interface FastifyInstance {
    /** Drizzle database handle. Plugins use `.execute(sql)` for raw
     *  queries against their own tables or `.select().from(...)` for
     *  typed queries against first-party schema they can import. */
    db: {
      execute: (query: unknown) => Promise<unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    };
    config: {
      domain: string;
      secureCookies: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    };
    broadcastToChannel: (channelId: string, message: WsServerMessage) => void;
    broadcastToAllSubscribers: (message: WsServerMessage) => void;
    broadcastToActor: (actorId: string, message: WsServerMessage) => void;
    /** Deliver an AS2 activity to all followers of a Group (server)
     *  actor. The loader resolves groupId → actor row, signs the
     *  request, and enqueues to each remote inbox. No-op if the group
     *  isn't local. Plugins call this instead of importing server
     *  federation internals directly. */
    deliverToGroupFollowers: (
      groupId: string,
      activity: Record<string, unknown>,
    ) => Promise<void>;
  }

  interface FastifyRequest {
    actor?: {
      id: string;
      uri: string;
      preferredUsername: string;
      displayName: string | null;
      local: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    };
  }
}

export {};
