# syntax=docker/dockerfile:1
# Two-stage build: compile the SPA with full deps, then ship a slim runtime that
# runs the Fastify server (which serves dist/ + /api and applies DB migrations on
# boot). No build tooling or devDependencies in the final image.

# ---- builder: install all deps + build the client ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: production deps + built assets only ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# pg_dump 16 (PGDG repo — bookworm's own client is v15, too old to dump our v16 db)
# + age for encrypted backups. Used by the automatic daily backup job
# (server/jobs/backup.ts); fetch tools are purged again to keep the image slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget ca-certificates gnupg \
 && wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 age \
 && apt-get purge -y wget gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
# Install production deps only (tsx is a prod dependency; the server runs as TS via tsx).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Built client + server source (server/db/migrations is applied on boot).
COPY --from=builder /app/dist ./dist
COPY server ./server
EXPOSE 5174
# Runs `tsx server/index.ts` (see package.json "start"): migrates, then serves.
CMD ["npm", "run", "start"]
