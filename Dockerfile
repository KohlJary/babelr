# SPDX-License-Identifier: Hippocratic-3.0
# Multi-stage Dockerfile for Babelr

# --- Stage 1: Install dependencies ---
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --ignore-scripts
# argon2 needs native build
RUN npm rebuild argon2

# --- Stage 2: Build ---
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build -w packages/shared
RUN npm run build -w packages/server
RUN npm run build -w packages/client

# --- Stage 3: Production ---
FROM node:24-slim AS production
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist/
COPY --from=build /app/packages/server/src/db/migrations packages/server/src/db/migrations/
COPY --from=build /app/packages/server/src/db/seed-data packages/server/src/db/seed-data/
COPY --from=build /app/packages/server/drizzle.config.ts packages/server/
COPY --from=build /app/packages/client/package.json packages/client/
COPY --from=build /app/packages/client/dist packages/client/dist/

# Install production deps + drizzle-kit for migrations (it's a
# devDependency but needed at runtime for the migrate command).
RUN npm ci --ignore-scripts && npm rebuild argon2
RUN npm install drizzle-kit --no-save

# Create uploads directory and symlink from the server CWD so both
# app.ts and files.ts find it regardless of which dir node runs from.
RUN mkdir -p /app/uploads && ln -sf /app/uploads /app/packages/server/uploads

EXPOSE 3000

# Run migrations then start server. Use the locally installed
# drizzle-kit binary (not npx, which downloads a separate copy
# that can't resolve the config's import).
# Copy seed data to dist so compiled plugins can find it.
RUN cp -r packages/server/src/db/seed-data packages/server/dist/db/seed-data 2>/dev/null || true

# Run from packages/server so relative paths for client dist
# (../client/dist) and uploads resolve correctly.
CMD ["sh", "-c", "cd /app/packages/server && /app/node_modules/.bin/drizzle-kit migrate && node dist/server.js"]
