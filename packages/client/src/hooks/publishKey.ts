// SPDX-License-Identifier: MIT
/** Publish this browser's public key for the signed-in account if the server has none.
 *  Never replaces a key that's there: another device may hold it. */
export interface PublishDeps {
  getMe: () => Promise<{ id: string }>;
  getUserPublicKey: (id: string) => Promise<{ publicKey: JsonWebKey | null }>;
  setPublicKey: (jwk: JsonWebKey) => Promise<void>;
  exportJwk: (k: CryptoKey) => Promise<JsonWebKey>;
}

export async function publishIfMissing(publicKey: CryptoKey, deps: PublishDeps): Promise<boolean> {
  const me = await deps.getMe();
  const { publicKey: onServer } = await deps.getUserPublicKey(me.id);
  if (onServer) return false;
  await deps.setPublicKey(await deps.exportJwk(publicKey));
  return true;
}
