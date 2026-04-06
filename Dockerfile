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
WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist/
COPY --from=build /app/packages/server/src/db/migrations packages/server/src/db/migrations/
COPY --from=build /app/packages/client/dist packages/client/dist/

# Install production deps only
RUN npm ci --omit=dev --ignore-scripts && npm rebuild argon2

EXPOSE 3000

CMD ["node", "--env-file=/app/.env", "packages/server/dist/server.js"]
