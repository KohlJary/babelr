// SPDX-License-Identifier: Hippocratic-3.0

function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function decryptMessage(
  ciphertext: string,
  iv: string,
  sharedKey: CryptoKey,
): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    sharedKey,
    fromBase64(ciphertext),
  );

  return new TextDecoder().decode(decrypted);
}
