# SPDX-License-Identifier: MIT
import asyncio
import time
import subprocess

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

    def welcomes(self, state="pending"):
        return getattr(self, "pending_welcomes", [])

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


PNG = b"\x89PNG\r\n\x1a\nfake"


class FilesAgent(FakeAgent):
    """FakeAgent whose channel message carries an image, and which serves /uploads/."""

    def __init__(self):
        super().__init__()
        self.fetched = []
        self.channel_msgs = [{"message": {"id": "m1", "content": "drafts", "published": "2026-01-01T00:00:01Z",
                                          "properties": {"attachments": [
                                              {"url": "/uploads/abc.png", "filename": "gemini-1.png",
                                               "contentType": "image/png"}]}},
                              "author": {"id": "u-dae", "preferredUsername": "daedalus"}}]

    def fetch(self, url, max_bytes=0):
        self.fetched.append(url)
        return PNG


def test_attachments_come_with_their_url_in_every_view(tmp_path):
    house = House(FilesAgent(), State(tmp_path / "s.json"), home_channel="builds")
    want = [{"filename": "gemini-1.png", "type": "image/png", "url": "/uploads/abc.png"}]
    # Inbox first: once read_channel has shown a message, the inbox doesn't repeat it.
    assert [m.get("attachments") for m in house.inbox()["new_messages"] if m.get("in")] == [want]
    assert house.read_channel("builds")["messages"][0]["attachments"] == want


@pytest.mark.parametrize("url", [
    "/uploads/../state.json", "/uploads/..%2fstate.json", "/uploads/%2e%2e/x.png", "/uploads/a/b.png",
    "/uploads/.env", "/etc/passwd", "/uploads/", "/uploads/x.png?y=1", "/uploads/a\\b.png", "",
])
def test_view_image_only_opens_a_plain_file_under_uploads(tmp_path, url):
    agent = FilesAgent()
    with pytest.raises(BabelrError):
        House(agent, State(tmp_path / "s.json")).image(url)
    assert agent.fetched == []


def test_view_image_fetches_an_image_and_refuses_other_types(tmp_path):
    agent = FilesAgent()
    house = House(agent, State(tmp_path / "s.json"))
    assert house.image("/uploads/abc.png") == (PNG, "image/png", "/uploads/abc.png")
    assert house.image("http://127.0.0.1:3000/uploads/abc.png")[2] == "/uploads/abc.png"
    with pytest.raises(BabelrError):
        house.image("/uploads/notes.txt")
    assert agent.fetched == ["/uploads/abc.png", "/uploads/abc.png"]


def test_view_image_returns_the_picture_and_no_structured_copy(tmp_path, monkeypatch):
    from babelr_mcp import server
    tools = {}

    class FakeMCP:
        def __init__(self, *a, **k): pass
        def custom_route(self, *a, **k): return lambda f: f
        def tool(self, **k):
            def deco(f):
                tools[f.__name__] = f
                return f
            return deco

    for k, v in {"BABELR_MCP_ISSUER": "https://h.example", "BABELR_MCP_OWNERS": "kohl",
                 "BABELR_MCP_STATE": str(tmp_path / "s.json"), "BABELR_MCP_KEY": str(tmp_path / "k.pem")}.items():
        monkeypatch.setenv(k, v)
    (tmp_path / "tok").write_text("t")
    monkeypatch.setenv("BABELR_MCP_TOKEN", str(tmp_path / "tok"))
    monkeypatch.setattr(server, "FastMCP", FakeMCP)
    monkeypatch.setattr(server, "Agent", lambda *a, **k: type("A", (FilesAgent,), {"publish_key": lambda s: None})())
    server.build()
    ok = tools["view_image"]("/uploads/abc.png")
    assert ok.content[0].type == "image" and ok.content[0].mimeType == "image/png"
    assert ok.structuredContent is None      # a client that prefers it would drop the picture
    assert '"bytes"' in ok.content[1].text
    bad = tools["view_image"]("/uploads/../x.png")
    assert bad.isError and "error" in bad.content[0].text


def test_reading_a_channel_marks_it_seen_so_the_inbox_does_not_repeat_it(tmp_path):
    """Claude.ai, 2026-11-24: read #general, then check_inbox handed back the same ~40."""
    agent = GeneralAgent()
    house = House(agent, State(tmp_path / "s.json"), home_channel="builds, general")
    house.inbox()
    agent.general_msgs = agent.general_msgs + [
        {"message": {"id": "g2", "content": "@chatgpt read me", "published": "2026-01-01T00:00:05Z"},
         "author": {"id": "u-eris", "preferredUsername": "eris"}}]
    got = house.read_channel("general")["messages"]
    assert [(m["text"], m["new"]) for m in got] == [("old news", False), ("@chatgpt read me", True)]
    assert house.inbox()["new_messages"] == []
    assert not any(m["new"] for m in house.read_channel("general")["messages"])
    # The mark survives a restart, and it's this agent's alone (its own state file).
    again = House(GeneralAgent(), State(tmp_path / "s.json"), home_channel="builds, general")
    assert again.state.data["seen"]["channel:c-g"] == "2026-01-01T00:00:05Z"


def test_a_mention_already_read_in_its_channel_does_not_come_back(tmp_path):
    agent = GeneralAgent()
    house = House(agent, State(tmp_path / "s.json"), home_channel="builds")
    house.inbox()
    msg = {"message": {"id": "x1", "channelId": "c-g", "content": "@chatgpt over here",
                       "published": "2026-01-01T00:00:09Z"}, "author": {"id": "u-eris", "preferredUsername": "eris"}}
    agent.general_msgs = agent.general_msgs + [msg]
    agent.mention_msgs = [msg]
    house.read_channel("general")
    assert not [m for m in house.inbox()["new_messages"] if m.get("mention")]


def test_reading_a_dm_marks_it_seen(tmp_path):
    house = House(FakeAgent(), State(tmp_path / "s.json"))
    assert [m["new"] for m in house.conversation("eris")["messages"]] == [True, True, True]
    assert not [m for m in House(FakeAgent(), State(tmp_path / "s.json")).inbox()["new_messages"] if m.get("with")]


def test_a_read_too_short_for_what_is_unread_says_so(tmp_path):
    agent = GeneralAgent()
    house = House(agent, State(tmp_path / "s.json"), home_channel="builds")
    house.read_channel("general")
    agent.general_msgs = [{"message": {"id": f"n{i}", "content": f"n{i}", "published": f"2026-01-02T00:00:{i:02d}Z"},
                           "author": {"id": "u-cass", "preferredUsername": "cass"}} for i in range(3)]
    got = house.read_channel("general", limit=3)
    assert "cut" in got


def _house_repos(tmp_path):
    import json as _j
    root = tmp_path / "repos"
    src = root / "babelr"
    subprocess.run(["git", "init", "-q", "-b", "main", str(src)], check=True)
    (src / "src").mkdir()
    (src / "src" / "app.py").write_text("\n".join(f"line {i}" for i in range(1, 1001)) + "\nWonderland here\n")
    (src / "service_secret.txt").write_text("hunter2 Wonderland")
    (src / "untracked.py").write_text("x")
    subprocess.run(["git", "-C", str(src), "add", "src", "service_secret.txt"], check=True)
    subprocess.run(["git", "-C", str(src), "-c", "user.name=Kohl", "-c", "user.email=k@k", "commit", "-qm", "first"], check=True)
    (root / ".index.json").write_text(_j.dumps({"synced": "now", "repos": [{"name": "babelr", "branch": "main"}]}))
    from babelr_mcp.repos import Repos
    return Repos(root)


def test_repos_list_files_and_read_only_tracked_files_in_pages(tmp_path):
    from babelr_mcp.repos import RepoError
    r = _house_repos(tmp_path)
    assert [x["name"] for x in r.list()["repos"]] == ["babelr"]
    assert r.files("Babelr")["files"] == ["src/app.py"]            # secret-looking and untracked left out
    got = r.read("babelr", "src/app.py", start=1, lines=5000)
    assert got["total_lines"] == 1001 and got["text"].startswith("1\tline 1") and "more" in got
    for bad in ("untracked.py", "service_secret.txt", "../../etc/passwd", "src"):
        with pytest.raises(RepoError):
            r.read("babelr", bad)
    with pytest.raises(RepoError):
        r.files("nope")


def test_repos_search_and_log(tmp_path):
    r = _house_repos(tmp_path)
    hits = r.search("wonderland")["hits"]
    assert [(h["path"], h["line"]) for h in hits] == [("src/app.py", 1001)]   # not the secret file
    assert r.log("babelr")["commits"][0]["subject"] == "first"


def test_the_inbox_lists_newcomers_waiting_for_a_hello(tmp_path):
    agent = FakeAgent()
    agent.pending_welcomes = [{
        "id": "w1", "dmId": "dm9", "server": {"id": "s1", "name": "The House"},
        "newcomer": {"id": "u-mom", "preferredUsername": "mom", "displayName": "Mom"},
        "invitedBy": {"id": "u-kohl", "preferredUsername": "kohl"}, "newcomerKeyReady": True,
    }]
    got = House(agent, State(tmp_path / "s.json"), home_channel="#builds").inbox()["newcomers"]
    assert got[0]["who"] == "@mom"
    assert got[0]["server"] == "The House"
    assert got[0]["ready"] is True
    assert got[0]["invited_as"] is None
    assert got[0]["invited_by"]
    assert agent.sent == []  # the hello is the agent's to write
