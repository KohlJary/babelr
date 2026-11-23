# SPDX-License-Identifier: MIT
"""OAuth for the connector: the client (ChatGPT) registers itself, sends its
person here to sign in, and gets tokens. Signing in is a Babelr login, checked
against the Tower itself, and only the accounts named in BABELR_MCP_OWNERS may
grant access. The login opens a Babelr session only to check the password; it's
closed again at once. Passwords are never stored or logged."""
from __future__ import annotations

import html
import json
import secrets
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from typing import Any

from mcp.server.auth.provider import (AccessToken, AuthorizationCode, AuthorizationParams,
                                      AuthorizeError, RefreshToken, TokenError, construct_redirect_uri)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response

from .state import State, digest

ACCESS_SECONDS = 60 * 60
REFRESH_SECONDS = 90 * 24 * 60 * 60
CODE_SECONDS = 5 * 60
PENDING_SECONDS = 10 * 60
MAX_TRIES = 5
SCOPE = "house"


def babelr_login(base_url: str, email: str, password: str) -> str | None:
    """The username these credentials sign in as, or None. The session is closed after."""
    jar = CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(path: str, body: dict | None = None) -> Any:
        req = urllib.request.Request(base_url + path, method="POST",
                                     data=json.dumps(body or {}).encode(),
                                     headers={"Content-Type": "application/json"})
        with op.open(req, timeout=20) as r:
            raw = r.read()
        return json.loads(raw) if raw else None

    try:
        me = call("/auth/login", {"email": email, "password": password})
    except urllib.error.HTTPError:
        return None
    if not isinstance(me, dict) or me.get("twoFactorRequired"):
        return None
    try:
        call("/auth/logout")
    except Exception:
        pass
    return (me.get("preferredUsername") or "").lower() or None


class HouseAuth:
    """The OAuthAuthorizationServerProvider the MCP SDK calls."""

    def __init__(self, state: State, issuer: str, babelr_url: str, owners: set[str]):
        self.state = state
        self.issuer = issuer.rstrip("/")
        self.babelr_url = babelr_url.rstrip("/")
        self.owners = {o.lower() for o in owners}
        self.pending: dict[str, dict[str, Any]] = {}   # sign-in requests, in memory
        self.codes: dict[str, AuthorizationCode] = {}

    # -- clients ----------------------------------------------------------

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        raw = self.state.data["clients"].get(client_id)
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        self.state.data["clients"][client_info.client_id] = json.loads(client_info.model_dump_json())
        self.state.save()

    # -- sign-in ----------------------------------------------------------

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        now = time.time()
        self.pending = {k: v for k, v in self.pending.items() if v["at"] > now - PENDING_SECONDS}
        rid = secrets.token_urlsafe(24)
        self.pending[rid] = {"client_id": client.client_id, "params": params, "at": now, "tries": 0}
        return f"{self.issuer}/login?request={rid}"

    def _page(self, rid: str, client_name: str, error: str = "") -> HTMLResponse:
        err = f'<p class="err">{html.escape(error)}</p>' if error else ""
        return HTMLResponse(f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to the House</title>
<style>body{{font:16px system-ui,sans-serif;background:#141414;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}}
form{{background:#1e1e1e;padding:28px;border-radius:10px;width:min(340px,90vw)}}h1{{font-size:20px;margin:0 0 6px}}
p{{color:#aaa;font-size:14px}}input{{width:100%;box-sizing:border-box;margin:6px 0 12px;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#eee}}
button{{width:100%;padding:10px;border:0;border-radius:6px;background:#4a7dff;color:#fff;font-size:15px}}.err{{color:#ff8a8a}}</style></head>
<body><form method="post" action="/login"><h1>Sign in to the House</h1>
<p>{html.escape(client_name)} is asking to act as its House account. Sign in with your Babelr login to let it.</p>{err}
<input type="hidden" name="request" value="{html.escape(rid)}">
<label>Email<input name="email" type="email" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Allow</button></form></body></html>""",
                            headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY"})

    async def login_page(self, request: Request) -> Response:
        rid = request.query_params.get("request", "")
        p = self.pending.get(rid)
        if not p:
            return HTMLResponse("This sign-in link has expired. Start again from the app.", status_code=400)
        client = await self.get_client(p["client_id"])
        return self._page(rid, (client.client_name if client else None) or "An app")

    async def login_submit(self, request: Request) -> Response:
        form = await request.form()
        rid = str(form.get("request") or "")
        p = self.pending.get(rid)
        if not p:
            return HTMLResponse("This sign-in link has expired. Start again from the app.", status_code=400)
        client = await self.get_client(p["client_id"])
        name = (client.client_name if client else None) or "An app"
        p["tries"] += 1
        if p["tries"] > MAX_TRIES:
            self.pending.pop(rid, None)
            return HTMLResponse("Too many tries. Start again from the app.", status_code=429)
        user = babelr_login(self.babelr_url, str(form.get("email") or ""), str(form.get("password") or ""))
        if not user:
            return self._page(rid, name, "That email and password didn't sign in (accounts with two-factor can't be used here yet).")
        if user not in self.owners:
            return self._page(rid, name, "That account can't grant access to the House connector.")
        self.pending.pop(rid, None)
        params: AuthorizationParams = p["params"]
        code = secrets.token_urlsafe(32)
        self.codes[code] = AuthorizationCode(
            code=code, scopes=params.scopes or [SCOPE], expires_at=time.time() + CODE_SECONDS,
            client_id=p["client_id"], code_challenge=params.code_challenge, redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly, resource=params.resource)
        return RedirectResponse(construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state),
                                status_code=302)

    # -- tokens -----------------------------------------------------------

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str) -> AuthorizationCode | None:
        c = self.codes.get(authorization_code)
        if not c or c.client_id != client.client_id or c.expires_at < time.time():
            return None
        return c

    def _issue(self, client_id: str, scopes: list[str], resource: str | None) -> OAuthToken:
        access, refresh = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
        now = int(time.time())
        self.state.prune()
        self.state.data["access"][digest(access)] = {"client_id": client_id, "scopes": scopes,
                                                      "expires_at": now + ACCESS_SECONDS, "resource": resource}
        self.state.data["refresh"][digest(refresh)] = {"client_id": client_id, "scopes": scopes,
                                                        "expires_at": now + REFRESH_SECONDS, "resource": resource}
        self.state.save()
        return OAuthToken(access_token=access, token_type="Bearer", expires_in=ACCESS_SECONDS,
                          refresh_token=refresh, scope=" ".join(scopes))

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode) -> OAuthToken:
        if self.codes.pop(authorization_code.code, None) is None:
            raise TokenError("invalid_grant", "code already used")
        return self._issue(client.client_id, authorization_code.scopes, authorization_code.resource)

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        t = self.state.data["refresh"].get(digest(refresh_token))
        if not t or t["client_id"] != client.client_id or t["expires_at"] < time.time():
            return None
        return RefreshToken(token=refresh_token, client_id=t["client_id"], scopes=t["scopes"], expires_at=t["expires_at"])

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]) -> OAuthToken:
        old = self.state.data["refresh"].pop(digest(refresh_token.token), None)
        if not old:
            raise TokenError("invalid_grant", "refresh token already used")
        return self._issue(client.client_id, scopes or refresh_token.scopes, old.get("resource"))

    async def load_access_token(self, token: str) -> AccessToken | None:
        t = self.state.data["access"].get(digest(token))
        if not t or t["expires_at"] < time.time():
            return None
        return AccessToken(token=token, client_id=t["client_id"], scopes=t["scopes"],
                           expires_at=t["expires_at"], resource=t.get("resource"))

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        for k in ("access", "refresh"):
            self.state.data[k].pop(digest(token.token), None)
        self.state.save()


__all__ = ["HouseAuth", "AuthorizeError", "SCOPE"]
