// SPDX-License-Identifier: Hippocratic-3.0
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { actors } from '../db/schema/actors.ts';
import type { Database } from '../db/index.ts';

export function generateActorKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export async function ensureActorKeys(
  db: Database,
  actor: typeof actors.$inferSelect,
): Promise<typeof actors.$inferSelect> {
  if (actor.privateKeyPem) return actor;

  const { publicKeyPem, privateKeyPem } = generateActorKeypair();

  const props = (actor.properties as Record<string, unknown>) ?? {};
  const apPublicKey = {
    id: `${actor.uri}#main-key`,
    owner: actor.uri,
    publicKeyPem,
  };

  const [updated] = await db
    .update(actors)
    .set({
      privateKeyPem,
      properties: { ...props, apPublicKey },
      updatedAt: new Date(),
    })
    .where(eq(actors.id, actor.id))
    .returning();

  return updated;
}
