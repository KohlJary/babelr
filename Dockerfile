# SPDX-License-Identifier: MIT
# Babelr, run the way the live server runs: from source with tsx, after building the
# shared packages and the client. (The old compile-to-dist image predated the plugin
# SDK and the plugins, which are TypeScript packages the server imports directly.)
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY . .
# --ignore-scripts skips the desktop app's Electron download; argon2 and mediasoup
# (its voice worker) are the native modules the server needs, so they're built on their own.
RUN npm ci --no-audit --no-fund --ignore-scripts && npm rebuild argon2 mediasoup
RUN npm run build
RUN mkdir -p /app/uploads && ln -sfn /app/uploads /app/packages/server/uploads

ENV NODE_ENV=production
WORKDIR /app/packages/server
EXPOSE 3000
CMD ["sh", "-c", "npm run db:migrate && exec /app/node_modules/.bin/tsx src/server.ts"]
