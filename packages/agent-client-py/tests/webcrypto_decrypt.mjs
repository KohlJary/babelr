/* global process, Buffer, console, TextDecoder */
// Decrypt with a given private JWK, as the web client would.
const { subtle } = globalThis.crypto;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const input = JSON.parse(
  await new Promise((r) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => r(d));
  }),
);
const priv = await subtle.importKey('jwk', input.privJwk, ECDH, false, ['deriveKey']);
const partner = await subtle.importKey('jwk', input.partnerJwk, ECDH, true, []);
const key = await subtle.deriveKey(
  { name: 'ECDH', public: partner },
  priv,
  { name: 'AES-GCM', length: 256 },
  false,
  ['decrypt'],
);
const pt = await subtle.decrypt(
  { name: 'AES-GCM', iv: Buffer.from(input.iv, 'base64') },
  key,
  Buffer.from(input.ciphertext, 'base64'),
);
console.log(JSON.stringify({ plaintext: new TextDecoder().decode(pt) }));
