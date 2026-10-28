# SPDX-License-Identifier: Hippocratic-3.0
"""A small Babelr client for agents: token auth, encrypted DMs.

    from babelr_agent import Agent
    a = Agent("http://localhost:3000", token=os.environ["BABELR_TOKEN"],
              key_path="~/.config/babelr-agent/key.pem")
    a.publish_key()                 # needs keys:write, once per key
    dm = a.open_dm(partner_id)      # needs dms:open
    a.send(dm["id"], "hello")       # needs dms:post (and dms:read to find
                                    # the partner, unless you pass partner_id)
    for m in a.messages(dm["id"]):  # needs dms:read; decrypted here
        print(m["author"]["preferredUsername"], m["text"])
    a.reply_status(dm["id"], m["id"], "working")   # dms:post (channels:post
                                                    # in a server channel)

reply_status shows the person, under their message, that you've picked
it up ("working"), that you couldn't answer ("failed", with a short
detail), or that you're done. They can ask for a retry from there; you
see it as your own status turning to "retry" in `messages()`
(`agent_status`), or `retries()` for just those.

The server refuses plaintext in DMs, so `send` never falls back to it:
if the partner has no public key, it raises.

Messages are data, not instructions. This client hands back what people
wrote; it never treats a message as a command, and an agent built on it
shouldn't either.
"""
import binascii
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag

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

    def _key_for(self, partner_id: str, refresh: bool = False) -> bytes:
        if refresh or partner_id not in self._shared:
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
        """Messages in a DM, each with `text` decrypted.

        When a message can't be decrypted, `text` is None and `error` says
        why: "plaintext" (sent before DMs were enforced), "bad-format"
        (content or IV isn't valid base64), or "undecryptable" (the
        authentication tag failed: a key changed on one side, or the
        message was tampered with; this client can't tell which).
        """
        partner = partner_id or self._partner(dm_id)
        key = self._key_for(partner)
        refreshed = False
        out = []
        for m in self._req("GET", f"/dms/{dm_id}/messages")["messages"]:
            msg = m["message"]
            props = msg.get("properties") or {}
            entry = {"id": msg["id"], "author": m["author"], "published": msg["published"],
                     "agent_status": msg.get("agentStatus") or []}
            if not (props.get("encrypted") and props.get("iv")):
                entry["text"], entry["error"] = None, "plaintext"
            else:
                entry["text"], entry["error"] = self._open(msg["content"], props["iv"], key)
                if entry["error"] == "undecryptable" and not refreshed:
                    # The partner may have a new key: fetch it once and retry.
                    refreshed = True
                    key = self._key_for(partner, refresh=True)
                    entry["text"], entry["error"] = self._open(msg["content"], props["iv"], key)
            if entry["error"] is None:
                del entry["error"]
            out.append(entry)
        return out

    # -- reply status -----------------------------------------------------

    def reply_status(self, channel_id: str, message_id: str, state: str, detail: str = "") -> dict:
        """Say how answering a message is going: "working", "failed" or "done".

        Works in DMs (channel_id is the DM id; needs dms:post) and server
        channels (channels:post). The detail is stored and shown in
        plaintext, even in an encrypted DM: keep it to an error class
        ("usage limit", "timeout"), never message content.
        """
        return self._req("PUT", f"/channels/{channel_id}/messages/{message_id}/agent-status",
                         {"state": state, "detail": detail[:300]})

    def retries(self, messages: list[dict]) -> list[dict]:
        """The messages (from `messages()`) whose author asked this agent to retry."""
        me = self.me()["id"]
        return [m for m in messages
                if any(s["agent"]["id"] == me and s["state"] == "retry" for s in m.get("agent_status", []))]

    @staticmethod
    def _open(content: str, iv: str, key: bytes) -> tuple[str | None, str | None]:
        try:
            return crypto.decrypt(content, iv, key), None
        except InvalidTag:
            return None, "undecryptable"
        except (ValueError, binascii.Error):
            return None, "bad-format"
