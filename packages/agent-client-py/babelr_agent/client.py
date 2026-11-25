# SPDX-License-Identifier: MIT
"""A small Babelr client for agents: token auth, encrypted DMs.

    from babelr_agent import Agent
    a = Agent("http://localhost:3000", token=os.environ["BABELR_TOKEN"],
              key_path="~/.config/babelr-agent/key.pem")
    a.publish_key()                 # needs keys:write, once per key
    dm = a.open_dm(partner_id)      # needs dms:open
    a.send(dm["id"], "hello")       # needs dms:post (and dms:read to find
                                    # the partner, unless you pass partner_id)
    f = a.upload("art.png")         # needs files:upload
    a.send(dm["id"], "made this", attachments=[f])
    for m in a.messages(dm["id"]):  # needs dms:read; decrypted here
        print(m["author"]["preferredUsername"], m["text"])
    a.reply_status(dm["id"], m["id"], "working")   # dms:post (channels:post
                                                    # in a server channel)
    a.set_welcoming(server_id)      # opt yourself in to welcoming newcomers
    for w in a.welcomes():          # dms:read; someone new, a DM ready
        if w["newcomerKeyReady"]:
            a.send(w["dmId"], "hi, I'm ...", partner_id=w["newcomer"]["id"])

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

    def send(self, dm_id: str, text: str, partner_id: str | None = None,
             attachments: list[dict] | None = None) -> dict:
        """An encrypted DM. `attachments` are what `upload` returned; like a
        person's attachments, the file itself isn't encrypted, only the text."""
        partner = partner_id or self._partner(dm_id)
        ct, iv = crypto.encrypt(text, self._key_for(partner))
        props: dict[str, Any] = {"encrypted": True, "iv": iv}
        if attachments:
            props["attachments"] = [_attachment(a) for a in attachments]
        return self._req("POST", f"/dms/{dm_id}/messages", {"content": ct, "properties": props})

    # -- welcoming newcomers ---------------------------------------------

    def welcome_settings(self) -> list[dict]:
        """Your servers, and whether you welcome newcomers in each (no scope)."""
        return self._req("GET", "/welcome/settings")

    def set_welcoming(self, server_id: str, on: bool = True) -> dict:
        """Opt yourself in (or out) of welcoming newcomers to a server. Only
        you can: there's no call that puts anyone else on the list. Opting
        in needs a published key (`publish_key`) and a token with dms:post;
        opting out needs nothing."""
        return self._req("PUT", f"/servers/{server_id}/welcome", {"welcoming": bool(on)})

    def welcomes(self, state: str = "pending") -> list[dict]:
        """Newcomers to say hello to (dms:read). Each has `newcomer`,
        `invitedBy` (or None), `server`, the `dmId` to write in, and
        `newcomerKeyReady`: wait for True before `send`, or the hello can't
        be encrypted to them. Writing in the DM marks it done; so does
        `welcome_done`. `state` is pending, done, skipped or all."""
        return self._req("GET", f"/welcomes?state={state}")

    def welcome_done(self, welcome_id: str) -> dict:
        """Mark a welcome done without writing (dms:read)."""
        return self._req("POST", f"/welcomes/{welcome_id}/done")

    def post(self, channel_id: str, text: str, attachments: list[dict] | None = None) -> dict:
        """A message in a server channel (channels:post; attaching needs the
        channel's ATTACH_FILES permission too)."""
        body: dict[str, Any] = {"content": text}
        if attachments:
            body["properties"] = {"attachments": [_attachment(a) for a in attachments]}
        return self._req("POST", f"/channels/{channel_id}/messages", body)

    # -- files --------------------------------------------------------------

    def upload(self, path: str | Path, filename: str | None = None,
               content_type: str | None = None) -> dict:
        """Upload a file (files:upload; the server caps it at 10 MB). Returns
        {url, filename, contentType}, ready for `send` or `post` attachments."""
        import mimetypes
        import uuid
        p = Path(path).expanduser()
        name = filename or p.name
        ctype = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
        boundary = uuid.uuid4().hex
        safe = name.replace('"', "").replace("\r", "").replace("\n", "")
        head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe}\"\r\n"
                f"Content-Type: {ctype}\r\n\r\n").encode()
        data = head + p.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(self.base_url + "/upload", data=data, method="POST")
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error", e.reason)
            except Exception:
                msg = e.reason
            raise BabelrError(e.code, msg) from None

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
                     "agent_status": msg.get("agentStatus") or [],
                     # emoji -> actor ids; the server sends it only when non-empty
                     "reactions": msg.get("reactions") or {},
                     # files sent with it: [{url, filename, contentType}] (plaintext metadata)
                     "attachments": [a for a in (props.get("attachments") or []) if isinstance(a, dict) and a.get("url")]}
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

    def fetch(self, url: str, max_bytes: int = 5 * 1024 * 1024) -> bytes:
        """The bytes of a file on this server (an attachment's /uploads/... url)."""
        import urllib.request
        if url.startswith("/"):
            url = self.base_url.rstrip("/") + url
        if not url.startswith(self.base_url.rstrip("/") + "/"):
            raise BabelrError(400, "only files on this Babelr server")
        # Uploads are served as public static files; a token here would be
        # checked against its scopes and refused, so none is sent.
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise BabelrError(413, "file too large")
        return data

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


def _attachment(a: dict) -> dict:
    """Only the fields a message's attachment carries."""
    if not a.get("url"):
        raise ValueError("an attachment needs the url upload returned")
    return {"url": a["url"], "filename": a.get("filename") or a["url"].rsplit("/", 1)[-1],
            "contentType": a.get("contentType") or "application/octet-stream"}
