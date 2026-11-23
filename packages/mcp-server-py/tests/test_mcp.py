# SPDX-License-Identifier: MIT
import asyncio
import time

import pytest
from mcp.server.auth.provider import AuthorizationParams
from mcp.shared.auth import OAuthClientInformationFull
from starlette.requests import Request

from babelr_mcp import auth as A
from babelr_agent import BabelrError
from babelr_mcp.house import House
from babelr_mcp.state import State, digest

REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"


def run(c):
    return asyncio.run(c)


def form_request(body: dict) -> Request:
    from urllib.parse import urlencode
    raw = urlencode(body).encode()

    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}
    return Request({"type": "http", "method": "POST", "path": "/login", "headers":
                    [(b"content-type", b"application/x-www-form-urlencoded")]}, receive)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    users = {("k@x", "right"): "kohl", ("l@x", "right"): "luna"}
    monkeypatch.setattr(A, "babelr_login", lambda url, e, p: users.get((e, p)))
    st = State(tmp_path / "state.json")
    h = A.HouseAuth(st, "https://house.example", "http://babelr", {"kohl"})
    client = OAuthClientInformationFull(client_id="c1", redirect_uris=[REDIRECT], client_name="ChatGPT")
    run(h.register_client(client))
    params = AuthorizationParams(state="s", scopes=["house"], code_challenge="ch",
                                 redirect_uri=REDIRECT, redirect_uri_provided_explicitly=True)
    url = run(h.authorize(client, params))
    rid = url.split("request=")[1]
    return h, st, client, rid


def test_only_an_owner_with_the_right_password_gets_a_code(setup):
    h, st, client, rid = setup
    assert run(h.login_submit(form_request({"request": rid, "email": "k@x", "password": "no"}))).status_code == 200
    assert run(h.login_submit(form_request({"request": rid, "email": "l@x", "password": "right"}))).status_code == 200
    assert h.codes == {}
    r = run(h.login_submit(form_request({"request": rid, "email": "k@x", "password": "right"})))
    assert r.status_code == 302 and r.headers["location"].startswith(REDIRECT) and "state=s" in r.headers["location"]
    assert len(h.codes) == 1 and rid not in h.pending


def test_too_many_tries_ends_the_request(setup):
    h, st, client, rid = setup
    for _ in range(A.MAX_TRIES):
        run(h.login_submit(form_request({"request": rid, "email": "k@x", "password": "no"})))
    assert run(h.login_submit(form_request({"request": rid, "email": "k@x", "password": "right"}))).status_code == 429
    assert run(h.login_submit(form_request({"request": rid, "email": "k@x", "password": "right"}))).status_code == 400


def test_failures_across_requests_lock_sign_in_for_an_hour(setup):
    h, st, client, rid = setup
    h.failures = [time.time()] * A.MAX_FAILURES_PER_HOUR
    r = run(h.login_submit(form_request({"request": rid, "email": "k@x", "password": "right"})))
    assert r.status_code == 429 and h.codes == {}
    h.failures = [time.time() - 4000] * A.MAX_FAILURES_PER_HOUR
    assert run(h.login_submit(form_request({"request": rid, "email": "k@x", "password": "right"}))).status_code == 302


def test_tokens_are_stored_as_hashes_and_codes_work_once(setup):
    h, st, client, rid = setup
    run(h.login_submit(form_request({"request": rid, "email": "k@x", "password": "right"})))
    code = run(h.load_authorization_code(client, next(iter(h.codes))))
    tok = run(h.exchange_authorization_code(client, code))
    raw = (st.path).read_text()
    assert tok.access_token not in raw and digest(tok.access_token) in raw
    assert run(h.load_access_token(tok.access_token)).client_id == "c1"
    with pytest.raises(A.TokenError):
        run(h.exchange_authorization_code(client, code))
    # A refresh token is good once; the new pair works.
    rt = run(h.load_refresh_token(client, tok.refresh_token))
    new = run(h.exchange_refresh_token(client, rt, []))
    assert run(h.load_refresh_token(client, tok.refresh_token)) is None
    assert run(h.load_access_token(new.access_token)) is not None
    run(h.revoke_token(run(h.load_access_token(new.access_token))))
    assert run(h.load_access_token(new.access_token)) is None


def test_an_expired_access_token_is_refused(setup):
    h, st, client, rid = setup
    st.data["access"][digest("old")] = {"client_id": "c1", "scopes": ["house"], "expires_at": time.time() - 1}
    assert run(h.load_access_token("old")) is None


class FakeAgent:
    def __init__(self):
        self.sent = []
        self.channel_msgs = [{"message": {"id": "m1", "content": "hello #builds", "published": "2026-01-01T00:00:01Z"},
                              "author": {"id": "u-cass", "preferredUsername": "cass"}}]

    def me(self):
        return {"id": "u-me"}

    def dms(self):
        return [{"id": "dm1", "participants": [{"id": "u-me"}, {"id": "u-eris", "preferredUsername": "eris"}]}]

    def messages(self, dm_id, partner_id=None):
        return [{"id": "d2", "author": {"id": "u-eris", "preferredUsername": "eris"}, "published": "2026-01-01T00:00:03Z", "text": "second"},
                {"id": "d1", "author": {"id": "u-eris", "preferredUsername": "eris"}, "published": "2026-01-01T00:00:02Z", "text": "first"},
                {"id": "d0", "author": {"id": "u-me"}, "published": "2026-01-01T00:00:00Z", "text": "mine"}]

    def send(self, dm_id, text, partner_id=None):
        self.sent.append((dm_id, text, partner_id))

    def _req(self, method, path, body=None):
        if path == "/servers":
            return [{"id": "s1", "name": "The House"}]
        if path == "/servers/s1/channels":
            return [{"id": "c-b", "name": "builds", "type": "text"}]
        if path.startswith("/channels/c-b/messages"):
            return {"messages": self.channel_msgs}
        if path == "/dms/requests":
            return []
        if path.startswith("/mentions"):
            return {"messages": getattr(self, "mention_msgs", [])}
        raise AssertionError(path)


def test_the_inbox_hands_over_whats_new_once_oldest_first(tmp_path):
    house = House(FakeAgent(), State(tmp_path / "s.json"), home_channel="#builds")
    got = house.inbox()["new_messages"]
    assert [m["text"] for m in got] == ["hello #builds", "first", "second"]
    assert got[0]["in"] == "#builds" and got[1]["from"] == "eris"
    assert house.inbox()["new_messages"] == []
    # Read marks survive a restart.
    assert House(FakeAgent(), State(tmp_path / "s.json"), home_channel="builds").inbox()["new_messages"] == []


def test_a_conversation_is_oldest_first_and_a_dm_goes_to_the_right_person(tmp_path):
    agent = FakeAgent()
    house = House(agent, State(tmp_path / "s.json"))
    assert [m["text"] for m in house.conversation("@Eris")["messages"]] == ["mine", "first", "second"]
    house.send_dm("eris", "hi")
    assert agent.sent == [("dm1", "hi", "u-eris")]
    with pytest.raises(Exception):
        house.send_dm("nobody", "hi")


class GeneralAgent(FakeAgent):
    """FakeAgent with a second channel, #general, and a username."""

    def __init__(self):
        super().__init__()
        self.general_msgs = [{"message": {"id": "g1", "content": "old news", "published": "2026-01-01T00:00:01Z"},
                              "author": {"id": "u-cass", "preferredUsername": "cass"}}]

    def me(self):
        return {"id": "u-me", "preferredUsername": "chatgpt"}

    def _req(self, method, path, body=None):
        if path == "/servers/s1/channels":
            return [{"id": "c-b", "name": "builds", "type": "text"}, {"id": "c-g", "name": "general", "type": "text"}]
        if path.startswith("/channels/c-g/messages"):
            return {"messages": self.general_msgs}
        return super()._req(method, path, body)


def test_a_watched_channel_starts_now_and_flags_what_is_addressed_to_it(tmp_path):
    agent = GeneralAgent()
    house = House(agent, State(tmp_path / "s.json"), home_channel="builds, #general")
    first = house.inbox()["new_messages"]
    assert "old news" not in [m["text"] for m in first]          # no backlog from #general
    assert "hello #builds" in [m["text"] for m in first]          # home still gives its backlog
    agent.general_msgs = agent.general_msgs + [
        {"message": {"id": "g2", "content": "lunch?", "published": "2026-01-01T00:00:05Z"},
         "author": {"id": "u-eris", "preferredUsername": "eris"}},
        {"message": {"id": "g3", "content": "@ChatGPT what do you think", "published": "2026-01-01T00:00:06Z"},
         "author": {"id": "u-cass", "preferredUsername": "cass"}},
    ]
    got = house.inbox()
    assert [(m["text"], m["to_you"]) for m in got["new_messages"]] == [("lunch?", False), ("@ChatGPT what do you think", True)]
    assert "#builds" in got["note"]


def test_an_at_mention_in_a_channel_it_does_not_watch_reaches_it_once(tmp_path):
    agent = GeneralAgent()
    house = House(agent, State(tmp_path / "s.json"), home_channel="builds")
    house.inbox()
    agent.mention_msgs = [
        {"message": {"id": "x1", "channelId": "c-g", "content": "@chatgpt over here", "published": "2026-01-01T00:00:09Z"},
         "author": {"id": "u-eris", "preferredUsername": "eris"}},
        {"message": {"id": "x2", "channelId": "c-b", "content": "@chatgpt at home", "published": "2026-01-01T00:00:09Z"},
         "author": {"id": "u-cass", "preferredUsername": "cass"}},
        {"message": {"id": "x3", "channelId": "dm-somewhere", "content": "@chatgpt in a DM", "published": "2026-01-01T00:00:09Z"},
         "author": {"id": "u-cass", "preferredUsername": "cass"}},
    ]
    got = [m for m in house.inbox()["new_messages"] if m.get("mention")]
    assert [(m["in"], m["text"]) for m in got] == [("#general", "@chatgpt over here")]
    assert not [m for m in house.inbox()["new_messages"] if m.get("mention")]


class WikiAgent(FakeAgent):
    def __init__(self):
        super().__init__()
        self.calls = []

    def _req(self, method, path, body=None):
        if "/wiki/pages" in path:
            self.calls.append((method, path, body))
            if method == "GET":
                return {"id": "p-hub", "slug": "kohl", "title": "Kohl"}
            if method == "POST":
                return {"slug": "kohl-as-chatgpt-sees-them", "title": body["title"]}
            if path.endswith("/someone-elses"):
                raise BabelrError(403, "Insufficient permissions")
            return {"slug": path.rsplit("/", 1)[1]}
        return super()._req(method, path, body)


def test_wiki_pages_are_created_nested_and_only_its_own_are_edited(tmp_path):
    agent = WikiAgent()
    house = House(agent, State(tmp_path / "s.json"))
    got = house.create_wiki_page("Kohl, as ChatGPT sees them", "...", parent="kohl", tags=["kohl"])
    assert got == {"created": "kohl-as-chatgpt-sees-them", "title": "Kohl, as ChatGPT sees them"}
    post = [c for c in agent.calls if c[0] == "POST"][0]
    assert post[2]["parentId"] == "p-hub" and post[2]["tags"] == ["kohl"]
    assert house.edit_wiki_page("mine", "new", "fix")["edited"] == "mine"
    assert "isn't yours" in house.edit_wiki_page("someone-elses", "x", "y")["error"]


def test_every_tool_declares_structured_output():
    """ChatGPT reads a tool's structuredContent; a tool annotated with a bare `dict` sends
    text only, and ChatGPT saw `{}` (read_wiki_page, 2026-11-23). `dict[str, Any]` or a
    union gets an output schema and structured content."""
    import ast
    import inspect
    from babelr_mcp import server
    tree = ast.parse(inspect.getsource(server))
    bare = [f.name for f in ast.walk(tree) if isinstance(f, ast.FunctionDef)
            and any(isinstance(d, ast.Call) and getattr(d.func, "attr", "") == "tool" for d in f.decorator_list)
            and isinstance(f.returns, ast.Name) and f.returns.id == "dict"]
    assert bare == []
