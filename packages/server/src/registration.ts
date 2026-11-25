// SPDX-License-Identifier: MIT
/**
 * Who may create an account, and the server invite codes that open the
 * door when REGISTRATION=invite.
 *
 * A registration invite is an ordinary server invite (`/invite/:code`):
 * the same link both creates the account and joins the person to the
 * server it belongs to, and it spends one of that invite's uses. Set
 * max uses and an expiry on invites you hand out; one with neither is a
 * standing door into the instance for anyone who sees the link.
 */
import type { FastifyRequest } from 'fastify';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { PERMISSIONS } from '@babelr/shared';
import { actors } from './db/schema/actors.ts';
import { invites } from './db/schema/invites.ts';
import { hasPermission } from './permissions.ts';
import type { Config, RegistrationMode } from './config.ts';
import type { createDb } from './db/index.ts';

type Db = ReturnType<typeof createDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type Invite = typeof invites.$inferSelect;
export type ServerActor = typeof actors.$inferSelect;

export type InviteCheck =
  | { ok: true; invite: Invite; server: ServerActor }
  | { ok: false; status: 404 | 410; error: string };

/** Codes are short hex (8 chars today); refuse anything else before
 *  it reaches the database. */
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function isInviteCodeShaped(code: unknown): code is string {
  return typeof code === 'string' && INVITE_CODE_RE.test(code);
}

/**
 * Look up an invite and say whether it can still let someone in: it
 * exists, hasn't expired or run out, its server is a local one, and whoever
 * made it is a person who isn't suspended and still may create invites
 * there. An agent with invite rights can't mint accounts, and taking an
 * admin's rights away closes the doors they opened.
 */
export async function checkInvite(db: Db, code: unknown): Promise<InviteCheck> {
  const invalid = { ok: false, status: 404, error: 'Invalid invite code' } as const;
  if (!isInviteCodeShaped(code)) return invalid;

  const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
  if (!invite) return invalid;

  if (invite.expiresAt && invite.expiresAt < new Date()) {
    return { ok: false, status: 410, error: 'Invite has expired' };
  }
  if (invite.maxUses && invite.uses >= invite.maxUses) {
    return { ok: false, status: 410, error: 'Invite has been used up' };
  }

  const [server] = await db
    .select()
    .from(actors)
    .where(and(eq(actors.id, invite.serverId), eq(actors.type, 'Group'), eq(actors.local, true)))
    .limit(1);
  if (!server?.followersUri) return invalid;

  const [creator] = await db
    .select({ id: actors.id, kind: actors.kind, suspendedAt: actors.suspendedAt })
    .from(actors)
    .where(eq(actors.id, invite.createdBy))
    .limit(1);
  if (
    !creator ||
    creator.kind !== 'person' ||
    creator.suspendedAt ||
    !(await hasPermission(db, server.id, creator.id, PERMISSIONS.CREATE_INVITES))
  ) {
    return { ok: false, status: 410, error: 'Invite is no longer valid' };
  }

  return { ok: true, invite, server };
}

/**
 * Spend one use of an invite, atomically: two people racing for the
 * last use can't both get it. Returns false when it ran out or expired
 * between the check and now.
 */
export async function consumeInvite(tx: Db | Tx, inviteId: string): Promise<boolean> {
  const rows = await tx
    .update(invites)
    .set({ uses: sql`${invites.uses} + 1` })
    .where(
      and(
        eq(invites.id, inviteId),
        or(isNull(invites.maxUses), lt(invites.uses, invites.maxUses)),
        or(isNull(invites.expiresAt), sql`${invites.expiresAt} > now()`),
      ),
    )
    .returning({ id: invites.id });
  return rows.length > 0;
}

/** No local person exists yet: the instance's first account. */
export async function isEmptyInstance(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.type, 'Person'), eq(actors.kind, 'person'), eq(actors.local, true)))
    .limit(1);
  return !row;
}

/** What an anonymous visitor may know about sign-up here. On an empty
 *  instance the first account is always allowed, so neither applies. */
export function registrationInfo(mode: RegistrationMode, empty: boolean) {
  return {
    mode,
    inviteRequired: mode === 'invite' && !empty,
    closed: mode === 'closed' && !empty,
  };
}

/**
 * The origin people's browsers use to reach this instance, for links
 * meant to be opened (invite links). PUBLIC_URL wins; otherwise a
 * request that arrived over https (directly, or through a proxy we
 * trust) uses its own origin, so an invite made from the tunnel URL
 * links to the tunnel URL; otherwise the old http(s)://BABELR_DOMAIN.
 */
export function publicOrigin(config: Config, request?: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  if (request && request.protocol === 'https' && request.host) {
    return `https://${request.host}`;
  }
  return `${config.secureCookies ? 'https' : 'http'}://${config.domain}`;
}
