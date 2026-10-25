# SPDX-License-Identifier: Hippocratic-3.0
"""Babelr's DM encryption, in Python, byte-compatible with the web client.

The web client (packages/client/src/crypto) does:
- ECDH on P-256, one key pair per actor;
- WebCrypto deriveKey(ECDH -> AES-GCM-256), which uses the raw 32-byte
  shared secret (the x coordinate) as the AES key, with no KDF;
- AES-GCM with a random 12-byte IV, ciphertext+tag base64, IV base64.

This module does the same, so an agent and a browser can read each
other's DMs. tests/test_interop.py checks it against Node's WebCrypto.
"""
import base64
import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def generate_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def load_or_create_key(path: Path) -> ec.EllipticCurvePrivateKey:
    """The agent's private key, kept on its own machine (mode 600).

    It never goes to the server. Lose it and the agent can't read DMs
    sent to its old public key.
    """
    path = Path(path)
    if path.exists():
        if path.stat().st_mode & 0o077:
            raise PermissionError(f"{path} is readable by others; chmod 600 it")
        try:
            key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        except ValueError as e:
            raise ValueError(f"{path} is not a usable key (corrupt or partly written)") from e
        if not isinstance(key, ec.EllipticCurvePrivateKey):
            raise ValueError(f"{path} is not a P-256 key")
        return key
    key = generate_key()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    # Write to a private temp file, then link it into place: a crash
    # can't leave a half-written key, and two processes racing to
    # create it end up with one key (the loser loads the winner's).
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
        f.flush()
        os.fsync(f.fileno())
    try:
        os.link(tmp, path)
    except FileExistsError:
        return load_or_create_key(path)
    finally:
        os.unlink(tmp)
    return key


def public_jwk(key: ec.EllipticCurvePrivateKey) -> dict:
    nums = key.public_key().public_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": _b64url(nums.x.to_bytes(32, "big")),
        "y": _b64url(nums.y.to_bytes(32, "big")),
    }


def jwk_to_public_key(jwk: dict) -> ec.EllipticCurvePublicKey:
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
        raise ValueError("not a P-256 key")
    x = int.from_bytes(_unb64url(jwk["x"]), "big")
    y = int.from_bytes(_unb64url(jwk["y"]), "big")
    return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()


def shared_key(key: ec.EllipticCurvePrivateKey, partner_jwk: dict) -> bytes:
    """What WebCrypto's deriveKey gives: the raw ECDH secret as the AES key."""
    return key.exchange(ec.ECDH(), jwk_to_public_key(partner_jwk))


def encrypt(plaintext: str, key: bytes) -> tuple[str, str]:
    """Returns (ciphertext, iv), both base64, as the server expects."""
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    return base64.b64encode(ct).decode(), base64.b64encode(iv).decode()


def decrypt(ciphertext: str, iv: str, key: bytes) -> str:
    return AESGCM(key).decrypt(
        base64.b64decode(iv, validate=True), base64.b64decode(ciphertext, validate=True), None
    ).decode()
