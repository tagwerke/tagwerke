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
# Install production deps only (tsx is a prod dependency; the server runs as TS via tsx).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Built client + server source (server/db/migrations is applied on boot).
COPY --from=builder /app/dist ./dist
COPY server ./server
EXPOSE 5174
# Runs `tsx server/index.ts` (see package.json "start"): migrates, then serves.
CMD ["npm", "run", "start"]
