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

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes* | Set by compose | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | -- | Random string for signing cookies. Generate with `openssl rand -hex 32` |
| `BABELR_DOMAIN` | Yes* | `localhost:3000` | Public domain for ActivityPub URIs. **Must be set correctly for federation.** |
| `PORT` | No | `3000` | Server port inside the container |
| `BABELR_PORT` | No | `3000` | Host port to expose (for avoiding conflicts with local dev) |
| `HOST` | No | `0.0.0.0` | Bind address |
| `NODE_ENV` | No | `production` | Set to `production` for secure cookies |
| `FEDERATION_MODE` | No | `open` | Federation policy: `open`, `allowlist`, or `blocklist` |
| `FEDERATION_DOMAINS` | No | -- | Comma-separated domain list for allowlist/blocklist mode |
| `OIDC_ISSUER` | No | -- | OIDC provider URL (e.g. `https://accounts.google.com`) |
| `OIDC_CLIENT_ID` | No | -- | OIDC client ID from your identity provider |
| `OIDC_CLIENT_SECRET` | No | -- | OIDC client secret |
| `OIDC_REDIRECT_URI` | No | -- | Callback URL: `https://your-domain/api/auth/oidc/callback` |
| `MEDIASOUP_ANNOUNCED_IP` | Yes for voice | -- | Public IP advertised to browsers for WebRTC. See [Voice channels](#voice-channels) below. |
| `MEDIASOUP_LISTEN_IP` | No | `0.0.0.0` in prod, `127.0.0.1` in dev | Bind address for RTC sockets. Leave as default unless you know why you're changing it. |
| `MEDIASOUP_RTC_MIN_PORT` | No | `40000` | Low end of the UDP port range used for voice media. |
| `MEDIASOUP_RTC_MAX_PORT` | No | `40099` | High end of the UDP port range. |

*When using `docker compose`, `DATABASE_URL` is set automatically to point at the Postgres container.

### Voice channels

Voice (and webcam / screen-share) use a mediasoup SFU embedded in the Babelr server process. Browsers connect directly to the server over UDP on the RTC port range — this media traffic does **not** go through your reverse proxy, only the WebSocket signaling does.

**Required setup for voice to work in production:**

1. Set `MEDIASOUP_ANNOUNCED_IP` to the public IP address that browsers will use to reach your server. This is almost always the same IP your DNS record resolves to. If you skip this, browsers will receive undialable ICE candidates and every voice join will fail.
2. Open UDP ports `40000–40099` (or your configured range) on your firewall. These are per-participant — each transport uses one UDP port, so ~2 ports per active voice participant. The 100-port default handles ~50 concurrent voice users per Tower; raise the range if you expect more.
3. If you're behind NAT (home lab, cloud with a private-IP VM), port-forward the UDP range to your Babelr host and set `MEDIASOUP_ANNOUNCED_IP` to the outside IP.

**Known limitation:** Firefox fails ICE when both browser and server are on the same machine via localhost loopback. Deployments with a real public `MEDIASOUP_ANNOUNCED_IP` don't hit this. If you're developing locally and need to test Firefox, use two machines on a LAN rather than two tabs on localhost.

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

Set `BABELR_DOMAIN=chat.example.com` and `NODE_ENV=production` in your `.env`.

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

When configured, a "Sign in with SSO" button appears on the login page. Users are redirected to your identity provider, and accounts are auto-provisioned on first login. Existing accounts are linked by email address.

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
