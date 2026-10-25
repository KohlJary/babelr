/* global process, Buffer, crypto, console, TextEncoder */
// Node's WebCrypto doing exactly what packages/client/src/crypto does.
// argv: mode, then JSON on stdin. Prints JSON.
const { subtle } = globalThis.crypto;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const AES = { name: 'AES-GCM', length: 256 };
const b64 = (b) => Buffer.from(b).toString('base64');
const input = JSON.parse(
  await new Promise((r) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => r(d));
  }),
);

const pair = await subtle.generateKey(ECDH, true, ['deriveKey']);
const partner = await subtle.importKey('jwk', input.partnerJwk, ECDH, true, []);
const key = await subtle.deriveKey({ name: 'ECDH', public: partner }, pair.privateKey, AES, false, [
  'encrypt',
  'decrypt',
]);
const myJwk = await subtle.exportKey('jwk', pair.publicKey);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await subtle.encrypt(
  { name: 'AES-GCM', iv },
  key,
  new TextEncoder().encode(input.plaintext),
);
console.log(JSON.stringify({ jwk: myJwk, ciphertext: b64(ct), iv: b64(iv) }));
// The private key goes to stderr so the test can decrypt the reply with it.
const priv = await subtle.exportKey('jwk', pair.privateKey);
console.error(JSON.stringify(priv));
