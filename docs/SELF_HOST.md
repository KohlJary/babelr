# Self-Hosting Babelr

## Docker (Recommended)

The fastest way to run Babelr:

```bash
# Clone the repo
git clone https://github.com/KohlJary/babelr.git
cd babelr

# Generate a session secret
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env

# Start everything
docker compose up -d
```

Babelr is now running at `http://localhost:3000`.

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

*When using `docker compose`, `DATABASE_URL` is set automatically to point at the Postgres container.

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

To federate with other Babelr instances, `BABELR_DOMAIN` must be the publicly-reachable hostname of your instance (e.g. `chat.example.com`). This value is baked into every ActivityPub URI your instance generates — changing it after the fact breaks existing federation relationships.

Users on other instances can:
- Add your users as friends via `username@chat.example.com`
- Join your servers via the remote join dialog
- See your channels, wiki pages, calendar events, and files
- Chat, react, and collaborate across instances in real time

All content is translated through each reader's preferred language automatically.

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

- `actors` -- Users (Person) and servers (Group)
- `objects` -- Messages (Note) and channels (OrderedCollection)
- `activities` -- ActivityPub audit log (Create, Follow, etc.)
- `collection_items` -- Server membership, DM participants
- `sessions` -- Authentication sessions

Migrations are plain SQL in `packages/server/src/db/migrations/`. To generate new migrations after schema changes: `npm run db:generate`.

## Backups

Back up the PostgreSQL database regularly:

```bash
pg_dump -U babelr babelr > backup.sql
```

Note: DM message content is stored as ciphertext (E2E encrypted). The database backup contains encrypted content, not plaintext. Users' private keys are stored only in their browsers.
