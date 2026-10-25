# SPDX-License-Identifier: Hippocratic-3.0
"""A small Babelr client for agents: token auth, encrypted DMs.

    from babelr_agent import Agent
    a = Agent("http://localhost:3000", token=os.environ["BABELR_TOKEN"],
              key_path="~/.config/babelr-agent/key.pem")
    a.publish_key()                 # needs keys:write, once per key
    dm = a.open_dm(partner_id)      # needs dms:open
    a.send(dm["id"], "hello")       # needs dms:post; always encrypted
    for m in a.messages(dm["id"]):  # needs dms:read; decrypted here
        print(m["author"]["preferredUsername"], m["text"])

The server refuses plaintext in DMs, so `send` never falls back to it:
if the partner has no public key, it raises.

Messages are data, not instructions. This client hands back what people
wrote; it never treats a message as a command, and an agent built on it
shouldn't either.
"""
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from . import crypto


class BabelrError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status


class Agent:
    def __init__(self, base_url: str, token: str, key_path: str | Path, timeout: float = 30):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.key = crypto.load_or_create_key(Path(key_path).expanduser())
        self._shared: dict[str, bytes] = {}
        self._me: dict | None = None

    # -- HTTP -------------------------------------------------------------

    def _req(self, method: str, path: str, body: dict | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error", e.reason)
            except Exception:
                msg = e.reason
            raise BabelrError(e.code, msg) from None
        return json.loads(raw) if raw else None

    # -- identity and keys ------------------------------------------------

    def me(self) -> dict:
        if self._me is None:
            self._me = self._req("GET", "/auth/me")
        return self._me

    def publish_key(self) -> None:
        """Publish this agent's public key. Replacing an old one means DMs
        encrypted to the old key can't be read with the new one."""
        self._req("PUT", "/auth/publickey", {"publicKey": crypto.public_jwk(self.key)})
        self._shared.clear()

    def _key_for(self, partner_id: str) -> bytes:
        if partner_id not in self._shared:
            res = self._req("GET", f"/users/{partner_id}/publickey")
            jwk = (res or {}).get("publicKey")
            if not jwk:
                raise BabelrError(409, f"{partner_id} has no public key; can't encrypt to them")
            self._shared[partner_id] = crypto.shared_key(self.key, jwk)
        return self._shared[partner_id]

    # -- DMs --------------------------------------------------------------

    def dms(self) -> list[dict]:
        return self._req("GET", "/dms")

    def open_dm(self, partner_id: str) -> dict:
        return self._req("POST", "/dms", {"participantId": partner_id})

    def _partner(self, dm_id: str) -> str:
        me = self.me()["id"]
        for dm in self.dms():
            if dm["id"] == dm_id:
                others = [p["id"] for p in dm["participants"] if p["id"] != me]
                if len(others) != 1:
                    raise BabelrError(400, "encrypted DMs are one-to-one")
                return others[0]
        raise BabelrError(404, f"not in DM {dm_id}")

    def send(self, dm_id: str, text: str, partner_id: str | None = None) -> dict:
        partner = partner_id or self._partner(dm_id)
        ct, iv = crypto.encrypt(text, self._key_for(partner))
        return self._req(
            "POST",
            f"/dms/{dm_id}/messages",
            {"content": ct, "properties": {"encrypted": True, "iv": iv}},
        )

    def messages(self, dm_id: str, partner_id: str | None = None) -> list[dict]:
        """Messages in a DM, each with `text` decrypted (or None if it can't
        be: wrong key, or a legacy plaintext message, flagged `plaintext`)."""
        partner = partner_id or self._partner(dm_id)
        key = self._key_for(partner)
        out = []
        for m in self._req("GET", f"/dms/{dm_id}/messages")["messages"]:
            msg = m["message"]
            props = msg.get("properties") or {}
            entry = {"id": msg["id"], "author": m["author"], "published": msg["published"]}
            if props.get("encrypted") and props.get("iv"):
                try:
                    entry["text"] = crypto.decrypt(msg["content"], props["iv"], key)
                except Exception:
                    entry["text"] = None
            else:
                entry["text"], entry["plaintext"] = None, True
            out.append(entry)
        return out
