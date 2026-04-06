// SPDX-License-Identifier: Hippocratic-3.0

function toBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

export async function encryptMessage(
  plaintext: string,
  sharedKey: CryptoKey,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, encoded);

  return {
    ciphertext: toBase64(encrypted),
    iv: toBase64(iv.buffer),
  };
}
