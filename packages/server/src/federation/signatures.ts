// SPDX-License-Identifier: Hippocratic-3.0
import { createSign, createVerify, createHash } from 'node:crypto';

const SIGNED_HEADERS = '(request-target) host date digest';

export function createDigest(body: string): string {
  const hash = createHash('sha256').update(body).digest('base64');
  return `SHA-256=${hash}`;
}

export function signRequest(
  privateKeyPem: string,
  keyId: string,
  method: string,
  url: string,
  body?: string,
): { headers: Record<string, string> } {
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();
  const digest = body ? createDigest(body) : createDigest('');
  const target = `${method.toLowerCase()} ${parsedUrl.pathname}`;

  const signingString = [
    `(request-target): ${target}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join('\n');

  const signer = createSign('sha256');
  signer.update(signingString);
  const signature = signer.sign(privateKeyPem, 'base64');

  const signatureHeader = [
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="${SIGNED_HEADERS}"`,
    `signature="${signature}"`,
  ].join(',');

  return {
    headers: {
      Date: date,
      Digest: digest,
      Signature: signatureHeader,
      Host: parsedUrl.host,
    },
  };
}

interface ParsedSignature {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
}

function parseSignatureHeader(header: string): ParsedSignature {
  const parts: Record<string, string> = {};
  const regex = /(\w+)="([^"]+)"/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    parts[match[1]] = match[2];
  }

  return {
    keyId: parts.keyId ?? '',
    algorithm: parts.algorithm ?? 'rsa-sha256',
    headers: (parts.headers ?? '').split(' '),
    signature: parts.signature ?? '',
  };
}

export function verifySignatureFromParts(
  publicKeyPem: string,
  signatureHeader: string,
  method: string,
  path: string,
  headers: Record<string, string | undefined>,
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);

  const signingString = parsed.headers
    .map((h) => {
      if (h === '(request-target)') {
        return `(request-target): ${method.toLowerCase()} ${path}`;
      }
      return `${h}: ${headers[h] ?? ''}`;
    })
    .join('\n');

  const verifier = createVerify('sha256');
  verifier.update(signingString);

  return verifier.verify(publicKeyPem, parsed.signature, 'base64');
}

export function getKeyIdFromSignature(signatureHeader: string): string {
  const parsed = parseSignatureHeader(signatureHeader);
  return parsed.keyId;
}
