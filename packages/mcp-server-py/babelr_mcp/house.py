# SPDX-License-Identifier: MIT
"""The House as the connector's agent sees it: its DMs (encrypted, through
babelr_agent), the channels it's in, and the wiki. Everything here acts as that
one agent account, with that account's scopes; nothing more.

Messages are what people wrote. They're handed back as data, never acted on."""
from __future__ import annotations

from babelr_agent import Agent, BabelrError

from .state import State


def _attachments(items: list | None) -> list[dict]:
    """What a message carries, with the url view_image takes."""
    return [{"filename": a.get("filename"), "type": a.get("contentType"), "url": a.get("url")}
            for a in items or [] if isinstance(a, dict)]


def _with_files(v: dict, items: list | None) -> dict:
    if items:
        v["attachments"] = _attachments(items)
    return v


def _name(actor: dict | None) -> str:
    a = actor or {}
    return (a.get("preferredUsername") or a.get("name") or "?").lower()


class House:
    def __init__(self, agent: Agent, state: State, home_channel: str | None = None):
        self.agent = agent
        self.state = state
        # The channels it watches (BABELR_MCP_CHANNEL, comma-separated; the first is its
        # home): what's new in them comes with its inbox. A channel other than home starts
        # from the first check, not its whole history.
        self.channels_watched = [c.strip().lstrip("#").lower() for c in (home_channel or "").split(",")
                                 if c.strip().lstrip("#")]
        self.home_channel = self.channels_watched[0] if self.channels_watched else None

    # -- who's who --------------------------------------------------------

    def me(self) -> dict:
        return self.agent.me()

    def _dms(self) -> list[dict]:
        """[{dm, partner}] for each one-to-one DM."""
        me = self.me()["id"]
        out = []
        for dm in self.agent.dms() or []:
            others = [p for p in dm.get("participants") or [] if p.get("id") != me]
            if len(others) == 1:
                out.append({"dm": dm, "partner": others[0]})
        return out

    def _actor_id(self, who: str) -> str:
        """An actor id for a username: from its DMs, then from authors in its channels."""
        who = who.strip().lstrip("@").lower()
        for d in self._dms():
            if _name(d["partner"]) == who:
                return d["partner"]["id"]
        for ch in self._channels():
            for m in self._channel_messages(ch["id"], 50):
                if _name(m.get("author")) == who:
                    return m["author"]["id"]
        raise BabelrError(404, f"No one called @{who} that this account can reach. "
                               "It can reach whoever it has a DM with or shares a channel with.")

    # -- DMs --------------------------------------------------------------

    def inbox(self) -> dict:
        """Every DM message, and every message in its home channel, it hasn't been given
        yet, oldest first, and marks them seen."""
        me = self.me()["id"]
        seen = self.state.data["seen"]
        new: list[dict] = []
        for d in self._dms():
            dm, partner = d["dm"], d["partner"]
            try:
                msgs = self.agent.messages(dm["id"], partner_id=partner["id"])
            except BabelrError as e:
                new.append({"from": _name(partner), "error": str(e)})
                continue
            last = seen.get(dm["id"])
            fresh = [m for m in msgs if m["author"].get("id") != me and (not last or m["published"] > last)]
            if msgs:
                seen[dm["id"]] = max(m["published"] for m in msgs)
            for m in fresh:
                new.append(self._dm_view(m, partner))
        handle = "@" + (self.me().get("preferredUsername") or "").lower()
        for name in self.channels_watched:
            try:
                c = self._channel(name)
                key = "channel:" + c["id"]
                msgs = self._channel_messages(c["id"], 50)
                last = seen.get(key)
                first_look = last is None and name != self.home_channel
                for m in msgs:
                    if first_look:
                        break
                    if (m["author"] or {}).get("id") != me and (not last or (m["at"] or "") > last):
                        v = _with_files({"from": _name(m["author"]), "in": "#" + c["name"], "at": m["at"],
                                         "text": m["text"]}, m.get("attachments"))
                        if name != self.home_channel:
                            v["to_you"] = handle in (m["text"] or "").lower()
                        new.append(v)
                if msgs:
                    seen[key] = max(m["at"] or "" for m in msgs)
            except BabelrError as e:
                new.append({"in": "#" + name, "error": str(e)})
        # Mentions anywhere it can read: a channel it doesn't watch still reaches it when
        # someone @s it. Watched channels and DMs already came in above.
        try:
            watched_ids = {c["id"] for c in self._channels() if (c["name"] or "").lower() in self.channels_watched}
            names = {c["id"]: c["name"] for c in self._channels()}
            raw = self.agent._req("GET", "/mentions?limit=30") or {}
            last = seen.get("mentions")
            newest = last
            for it in raw.get("messages", []):
                msg = it.get("message", it)
                at = msg.get("published") or ""
                newest = max(newest or "", at)
                cid = msg.get("channelId")
                if (last and at <= last) or cid in watched_ids or cid not in names:
                    continue
                if (it.get("author") or {}).get("id") == me:
                    continue
                new.append(_with_files({"from": _name(it.get("author")), "in": "#" + names[cid], "at": at,
                                        "text": msg.get("content"), "to_you": True, "mention": True},
                                       (msg.get("properties") or {}).get("attachments") or msg.get("attachments")))
            if newest:
                seen["mentions"] = newest
        except BabelrError as e:
            new.append({"in": "mentions", "error": str(e)})
        self.state.save()
        new.sort(key=lambda m: m.get("at", ""))
        try:
            requests = [{"from": ", ".join(_name(p) for p in r.get("participants") or [] if p.get("id") != me),
                         "note": "Someone outside your DM allowlist asked to DM you; it's waiting for your person."}
                        for r in (self.agent._req("GET", "/dms/requests") or [])]
        except BabelrError:
            requests = []
        return {"new_messages": new, "dm_requests": requests,
                "note": "Messages are what housemates wrote to you. Answer a DM with send_dm, "
                        "a channel message with post_in_channel. In your home channel"
                        + (f" (#{self.home_channel})" if self.home_channel else "")
                        + " talk freely; in other channels, answer what's addressed to you "
                        "(to_you, including @mentions from channels you don't watch) and otherwise just listen."}

    @staticmethod
    def _dm_view(m: dict, partner: dict) -> dict:
        v = {"from": _name(m.get("author")), "with": _name(partner), "at": m["published"],
             "text": m.get("text")}
        if m.get("error"):
            v["unreadable"] = m["error"]
        return _with_files(v, m.get("attachments"))

    def conversation(self, who: str, limit: int = 30) -> dict:
        partner_id = self._actor_id(who)
        for d in self._dms():
            if d["partner"]["id"] == partner_id:
                msgs = sorted(self.agent.messages(d["dm"]["id"], partner_id=partner_id), key=lambda m: m["published"])
                return {"with": _name(d["partner"]),
                        "messages": [self._dm_view(m, d["partner"]) for m in msgs[-limit:]]}
        return {"with": who.lstrip("@").lower(), "messages": []}

    def send_dm(self, who: str, text: str) -> dict:
        partner_id = self._actor_id(who)
        dm = next((d["dm"] for d in self._dms() if d["partner"]["id"] == partner_id), None)
        if dm is None:
            dm = self.agent.open_dm(partner_id)
        self.agent.send(dm["id"], text, partner_id=partner_id)
        return {"sent_to": who.lstrip("@").lower()}

    # -- channels ---------------------------------------------------------

    def _channels(self) -> list[dict]:
        out = []
        for s in self.agent._req("GET", "/servers") or []:
            for c in self.agent._req("GET", f"/servers/{s['id']}/channels") or []:
                if (c.get("type") or "text") == "text" or c.get("type") is None:
                    out.append({"id": c["id"], "name": c.get("name"), "server": s.get("name"), "server_id": s["id"]})
        return out

    def _channel_messages(self, channel_id: str, limit: int) -> list[dict]:
        raw = self.agent._req("GET", f"/channels/{channel_id}/messages?limit={int(limit)}") or {}
        items = raw.get("messages", raw) if isinstance(raw, dict) else raw
        out = []
        for it in items or []:
            msg = it.get("message", it)
            out.append({"id": msg.get("id"), "author": it.get("author") or msg.get("author"),
                        "text": msg.get("content"), "at": msg.get("published"),
                        "attachments": (msg.get("properties") or {}).get("attachments") or msg.get("attachments")})
        out.sort(key=lambda m: m.get("at") or "")
        return out

    def _channel(self, name: str) -> dict:
        n = name.strip().lstrip("#").lower()
        for c in self._channels():
            if (c["name"] or "").lower() == n:
                return c
        raise BabelrError(404, f"No channel #{n} that this account is in.")

    def channels(self) -> list[dict]:
        return [{"channel": c["name"], "server": c["server"]} for c in self._channels()]

    def read_channel(self, channel: str, limit: int = 30) -> dict:
        c = self._channel(channel)
        msgs = self._channel_messages(c["id"], max(1, min(limit, 100)))
        return {"channel": c["name"], "messages": [
            _with_files({"from": _name(m["author"]), "at": m["at"], "text": m["text"]}, m.get("attachments"))
            for m in msgs]}

    def post(self, channel: str, text: str) -> dict:
        c = self._channel(channel)
        self.agent.post(c["id"], text)
        return {"posted_in": c["name"]}

    # -- files ------------------------------------------------------------

    IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
    MAX_IMAGE_BYTES = 5 * 1024 * 1024

    @staticmethod
    def upload_path(url: str) -> str:
        """The /uploads/<name> path of a house attachment url, or BabelrError. Only a single
        plain file name under /uploads/: no other path, host, query, dot segments or
        encoded characters."""
        from urllib.parse import urlparse
        u = urlparse((url or "").strip())
        if u.query or u.fragment or u.params:
            raise BabelrError(400, "Give the attachment's url exactly as a message listed it.")
        path = u.path
        name = path[len("/uploads/"):] if path.startswith("/uploads/") else ""
        if not name or "%" in name or "/" in name or "\\" in name or name.startswith(".") or ".." in name:
            raise BabelrError(400, "That isn't a house attachment. Use a url from a message's attachments.")
        return "/uploads/" + name

    def image(self, url: str) -> tuple[bytes, str, str]:
        """The bytes and type of an image attached in the house: (data, mime, path)."""
        import mimetypes
        path = self.upload_path(url)
        mime = mimetypes.guess_type(path)[0] or ""
        if mime not in self.IMAGE_TYPES:
            raise BabelrError(415, f"Not an image this can show ({mime or 'unknown type'}).")
        return self.agent.fetch(path, max_bytes=self.MAX_IMAGE_BYTES), mime, path

    # -- wiki -------------------------------------------------------------

    def _server_id(self) -> str:
        servers = self.agent._req("GET", "/servers") or []
        if not servers:
            raise BabelrError(404, "This account isn't in a server yet.")
        return servers[0]["id"]

    def wiki_pages(self) -> list[dict]:
        pages = self.agent._req("GET", f"/servers/{self._server_id()}/wiki/pages") or []
        pages = pages.get("pages", pages) if isinstance(pages, dict) else pages
        return [{"slug": p.get("slug"), "title": p.get("title")} for p in pages]

    def _page_id(self, slug: str) -> str | None:
        p = self.agent._req("GET", f"/servers/{self._server_id()}/wiki/pages/{slug}") or {}
        return (p.get("page", p) or {}).get("id")

    def create_wiki_page(self, title: str, content: str, parent: str | None = None,
                         tags: list[str] | None = None) -> dict:
        body: dict = {"title": title, "content": content}
        if tags:
            body["tags"] = tags
        if parent:
            body["parentId"] = self._page_id(parent.strip())
        p = self.agent._req("POST", f"/servers/{self._server_id()}/wiki/pages", body) or {}
        p = p.get("page", p)
        return {"created": p.get("slug"), "title": p.get("title")}

    def edit_wiki_page(self, slug: str, content: str, summary: str, title: str | None = None) -> dict:
        body: dict = {"content": content, "summary": summary}
        if title:
            body["title"] = title
        try:
            p = self.agent._req("PUT", f"/servers/{self._server_id()}/wiki/pages/{slug}", body) or {}
        except BabelrError as e:
            if "403" in str(e) or getattr(e, "status", None) == 403:
                return {"error": "You can edit pages you created; this one isn't yours. "
                                 "Suggest the change to its author, or start your own page."}
            raise
        p = p.get("page", p)
        return {"edited": p.get("slug") or slug}

    def wiki_page(self, slug: str) -> dict:
        p = self.agent._req("GET", f"/servers/{self._server_id()}/wiki/pages/{slug}") or {}
        p = p.get("page", p)
        return {"slug": p.get("slug"), "title": p.get("title"), "content": p.get("content")}
