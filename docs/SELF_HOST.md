# Self-Hosting Your Tower

A Babelr deployment is called a **Tower**. Each organization runs their own Tower, and Towers federate with each other via ActivityPub.

## Docker (Recommended)

The fastest way to stand up a Tower:

```bash
# Clone the repo
git clone https://github.com/KohlJary/babelr.git
cd babelr

# Generate a session secret
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env

# Start everything
docker compose up -d
```

Your Tower is now running at `http://localhost:3000`.

### Configuration

Set these in your `.env` file or as environment variables:

| Variable                 | Required      | Default                               | Description                                                                               |
| ------------------------ | ------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Yes\*         | Set by compose                        | PostgreSQL connection string                                                              |
| `SESSION_SECRET`         | Yes           | --                                    | Random string for signing cookies. Generate with `openssl rand -hex 32`                   |
| `BABELR_DOMAIN`          | Yes\*         | `localhost:3000`                      | Public domain for ActivityPub URIs. **Must be set correctly for federation.**             |
| `PORT`                   | No            | `3000`                                | Server port inside the container                                                          |
| `BABELR_PORT`            | No            | `3000`                                | Host port to expose (for avoiding conflicts with local dev)                               |
| `HOST`                   | No            | `0.0.0.0`                             | Bind address                                                                              |
| `NODE_ENV`               | No            | `production`                          | Set to `production` for secure cookies                                                    |
| `REGISTRATION`           | No            | `open`                                | Who can sign up: `open`, `invite` (needs a server invite link) or `closed`. See below.    |
| `TRUST_PROXY`            | No            | `true` in prod, `false` otherwise     | Whose `X-Forwarded-*` headers to believe. `loopback` for a tunnel or proxy on this host.  |
| `PUBLIC_URL`             | No            | --                                    | The https origin browsers use, if not `BABELR_DOMAIN` (a tunnel). Used for invite links.  |
| `FEDERATION_MODE`        | No            | `open`                                | Federation policy: `open`, `allowlist`, or `blocklist`                                    |
| `FEDERATION_DOMAINS`     | No            | --                                    | Comma-separated domain list for allowlist/blocklist mode                                  |
| `OIDC_ISSUER`            | No            | --                                    | OIDC provider URL (e.g. `https://accounts.google.com`)                                    |
| `OIDC_CLIENT_ID`         | No            | --                                    | OIDC client ID from your identity provider                                                |
| `OIDC_CLIENT_SECRET`     | No            | --                                    | OIDC client secret                                                                        |
| `OIDC_REDIRECT_URI`      | No            | --                                    | Callback URL: `https://your-domain/api/auth/oidc/callback`                                |
| `MEDIASOUP_ANNOUNCED_IP` | Yes for voice | --                                    | Public IP advertised to browsers for WebRTC. See [Voice channels](#voice-channels) below. |
| `MEDIASOUP_LISTEN_IP`    | No            | `0.0.0.0` in prod, `127.0.0.1` in dev | Bind address for RTC sockets. Leave as default unless you know why you're changing it.    |
| `MEDIASOUP_RTC_MIN_PORT` | No            | `40000`                               | Low end of the UDP port range used for voice media.                                       |
| `MEDIASOUP_RTC_MAX_PORT` | No            | `40099`                               | High end of the UDP port range.                                                           |

\*When using `docker compose`, `DATABASE_URL` is set automatically to point at the Postgres container.

### Voice channels

Voice (and webcam / screen-share) use a mediasoup SFU embedded in the Babelr server process. Browsers connect directly to the server over UDP on the RTC port range — this media traffic does **not** go through your reverse proxy, only the WebSocket signaling does.

**Required setup for voice to work in production:**

1. Set `MEDIASOUP_ANNOUNCED_IP` to the public IP address that browsers will use to reach your server. This is almost always the same IP your DNS record resolves to. If you skip this, browsers will receive undialable ICE candidates and every voice join will fail.
2. Open UDP ports `40000–40099` (or your configured range) on your firewall. These are per-participant — each transport uses one UDP port, so ~2 ports per active voice participant. The 100-port default handles ~50 concurrent voice users per Tower; raise the range if you expect more.
3. If you're behind NAT (home lab, cloud with a private-IP VM), port-forward the UDP range to your Babelr host and set `MEDIASOUP_ANNOUNCED_IP` to the outside IP.

**Known limitation:** Firefox fails ICE when both browser and server are on the same machine via localhost loopback. Deployments with a real public `MEDIASOUP_ANNOUNCED_IP` don't hit this. If you're developing locally and need to test Firefox, use two machines on a LAN rather than two tabs on localhost.

### Federated voice channels

A user on Tower B can join a voice channel that lives on Tower A. The flow:

1. Browser asks its home Tower (B) for a voice federation token, identifying the remote channel by URI.
2. Home Tower B HTTP-signs a request to Tower A's `/api/voice/federation-token` on the user's behalf.
3. Tower A verifies the signature, checks the user is a member of the owning Group, checks federation policy, and issues a 5-minute JWT scoped to that one channel.
4. Browser opens its WebSocket directly to **Tower A** (`wss://tower-a/ws?token=…`) and joins the SFU there. Voice / video / screen-share RTP all flows browser ↔ Tower A's SFU; Tower B is not in the media path.

For this to work end-to-end:

- Both Towers' `MEDIASOUP_ANNOUNCED_IP` values must be reachable from the federating browsers (they are dialed directly).
- Both Towers' RTC port ranges must be open at their respective firewalls.
- Federation policy (`FEDERATION_MODE` + `FEDERATION_DOMAINS`) on Tower A must allow Tower B's domain.

Privacy note: with the default direct-signaling flow, Tower A learns the joining user's browser IP. A future config toggle (`VOICE_FEDERATION_PROXY`, on the roadmap) will let self-hosters proxy signaling through the home Tower to hide member IPs from remote Towers.

### Production Deployment

For production, put Babelr behind a reverse proxy (nginx, Caddy, Traefik) with TLS:

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Set `BABELR_DOMAIN=chat.example.com` and `NODE_ENV=production` in your `.env`. Production trusts `X-Forwarded-*` from any peer. If port 3000 is reachable from anywhere but the proxy, set `TRUST_PROXY=loopback` (or the proxy's address) as well.

### Who can sign up

`REGISTRATION` decides who can make an account:

- `open` (the default): anyone who can reach the server.
- `invite`: only someone holding a working server invite link. The link both creates their account and joins them to that server. It spends one of the invite's uses.
- `closed`: nobody.

In every mode the first person on an empty instance can register, so someone is able to make the first invite. Agent and service accounts that a member sponsors are made the same way in every mode. Federation's nodeinfo reports `openRegistrations: true` only in `open` mode. In `invite` and `closed` mode, SSO signs in existing accounts but doesn't create new ones.

An invite opens the door only while it is unexpired, has uses left, and was made by a person who isn't suspended and still has **Create invites** on that server. Invites made by an agent never create accounts. By default the `@everyone` role has **Create invites**, so in `invite` mode any member can bring someone in. Take the permission off `@everyone` if you want only admins to. Give every invite you hand out a max-uses count and an expiry: an invite with neither stays open for anyone who sees the link.

Login and the 2FA step are limited to 10 tries a minute per IP, sign-up to 10 per 15 minutes, and anonymous invite lookups to 30 a minute. These limits apply on top of the global API limit.

### Reaching your house from your phone

Phones outside your network need an **https** URL. DMs are end-to-end encrypted with WebCrypto, which browsers only allow in a secure context (https, or `localhost` on the machine itself), so DMs won't work from a phone over plain `http://192.168...`. The service worker and push notifications need https too.

A Cloudflare quick tunnel is the fastest way to get an https URL, and you don't need an account:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a `https://<random-words>.trycloudflare.com` URL. **That URL changes every time cloudflared restarts**, and any invite links you've already sent stop working when it does. For a URL that stays the same, use a named tunnel on your own domain (or any reverse proxy with TLS, above).

Before you open the tunnel, close registration to invites. Set these in `.env` and restart Babelr:

```bash
REGISTRATION=invite
TRUST_PROXY=loopback
# Optional: only if you want invite links made from localhost to use the tunnel URL.
# PUBLIC_URL=https://<random-words>.trycloudflare.com
```

- `REGISTRATION=invite`: strangers who find the URL can't make accounts.
- `TRUST_PROXY=loopback`: Babelr believes the `X-Forwarded-Proto/For/Host` headers that cloudflared, running on the same machine, adds, and nobody else's. Session cookies get the `Secure` flag when the browser used https, rate limits count each visitor's own IP (without this, everyone coming through the tunnel shares one bucket), and invite links made from the tunnel URL point at the tunnel URL. Plain `http://localhost:3000` works exactly as before.
- `PUBLIC_URL`: invite links (and verification emails) use this origin. If you leave it unset, invite links follow the address you made them from: make the invite while browsing the tunnel URL and the link is the tunnel URL. With a quick tunnel, leaving it unset saves you editing `.env` every time the URL changes.
- Leave `BABELR_DOMAIN` and `NODE_ENV` alone. `BABELR_DOMAIN` is baked into every ActivityPub id, so don't set it to a tunnel URL that will change.

To invite someone:

1. Open the house at the tunnel URL and log in.
2. Go to **Server settings > Invites**. Set max uses to `1` and an expiry (e.g. `48` hours), then press Create.
3. Copy the link (`https://<tunnel>/invite/<code>`) and send it to them.
4. They open it on their phone. The page says which server they've been invited to and starts on **Register**. They pick a username, email and password (12+ characters), and they're in that server.

Voice and video aren't carried by the tunnel: media goes over UDP straight to `MEDIASOUP_ANNOUNCED_IP` (see [Voice channels](#voice-channels)). Chat, DMs, files and the rest work through it. The `allowedHosts` list in the client's Vite config only affects the dev server (`npm run dev:client`). Babelr serves the built client itself, so the tunnel doesn't need it.

### Federation

To federate with other Towers, `BABELR_DOMAIN` must be the publicly-reachable hostname of your Tower (e.g. `chat.example.com`). This value is baked into every ActivityPub URI your Tower generates — changing it after the fact breaks existing federation relationships.

Users on other Towers can:

- Add your users as friends via `username@chat.example.com`
- Join your servers via the remote join dialog
- See your channels, wiki pages, calendar events, and files
- Chat, react, and collaborate across instances in real time

All content is translated through each reader's preferred language automatically.

### Federation Access Control

By default, your Tower federates openly with any other instance. For restricted environments, set a federation policy:

```bash
# Only federate with specific Towers
FEDERATION_MODE=allowlist
FEDERATION_DOMAINS=partner.example.com,hq.example.com

# Or block specific instances
FEDERATION_MODE=blocklist
FEDERATION_DOMAINS=spam.example.com
```

The policy is enforced at all federation checkpoints — inbound activities are rejected, outbound deliveries are skipped, and remote server joins are blocked for disallowed domains.

### Single Sign-On (OIDC)

Babelr supports enterprise SSO via any OpenID Connect provider (Google, Azure AD, Okta, Auth0, Keycloak, etc.). Set all four OIDC variables to enable:

```bash
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URI=https://chat.example.com/api/auth/oidc/callback
```

When configured, a "Sign in with SSO" button appears on the login page. Users are redirected to your identity provider, and accounts are auto-provisioned on first login (only when `REGISTRATION=open`). Existing accounts are linked by email address.

The first user to sign in via SSO becomes the instance admin (same as password registration).

## Manual Setup

### Prerequisites

- Node.js 24+
- PostgreSQL 17+
- npm 11+

### Steps

```bash
# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env: set DATABASE_URL and SESSION_SECRET

# Create database and run migrations
createdb babelr
npm run db:migrate

# Build all packages
npm run build

# Start
npm run start -w packages/server
```

The server runs on port 3000. In production, build the client (`npm run build -w packages/client`) and serve the `packages/client/dist` directory via your web server or configure the Fastify server to serve static files.

## Database

Babelr uses PostgreSQL with Drizzle ORM. The schema is ActivityPub-shaped:

- `actors` — Users (Person) and servers (Group)
- `objects` — Messages (Note) and channels (OrderedCollection)
- `activities` — ActivityPub activity log (Create, Follow, etc.)
- `collection_items` — Server membership, DM participants
- `sessions` — Authentication sessions
- `wiki_pages`, `wiki_page_revisions`, `wiki_page_links` — Wiki with revision history and backlinks
- `events`, `event_attendees` — Calendar events with RSVPs
- `server_files` — Per-server file library
- `server_roles`, `server_role_assignments` — Granular permissions
- `audit_logs` — Admin action history

Migrations are plain SQL in `packages/server/src/db/migrations/`. To generate new migrations after schema changes: `npm run db:generate`.

## Backups

Back up the PostgreSQL database regularly:

```bash
pg_dump -U babelr babelr > backup.sql
```

Note: DM message content is stored as ciphertext (E2E encrypted). The database backup contains encrypted content, not plaintext. Users' private keys are stored only in their browsers.
