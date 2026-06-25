# Self-hosting do-app

Stand up your own private do-app instance in a few minutes on a single machine. All data
stays on your server — see [DATA_RESIDENCY.md](DATA_RESIDENCY.md).

## Requirements

- A Linux host (a small VPS is plenty) or any machine with **Docker** + the **Docker
  Compose** plugin. Nothing else — no Node, no Postgres install needed on the host.
- ~1 GB RAM and ~2 GB disk to start.

## Quick start (under 10 minutes)

```bash
# 1. Get the code
git clone <your-do-app-repo-url> do-app && cd do-app

# 2. Configure secrets
cp .env.example .env
#    Edit .env and set at least:
#      SESSION_SECRET      -> a long random string  (e.g. `openssl rand -base64 48`)
#      POSTGRES_PASSWORD   -> a strong database password

# 3. Build and start (app + database)
docker compose up -d --build

# 4. Mint your first signup invite (registration is invite-only)
docker compose exec app npm run invite
#    -> prints an invite code. Copy it.

# 5. Open the app
#    http://<your-server>:5174   (or http://localhost:5174 locally)
#    Sign up with the invite code from step 4. You're in.
```

That's it. The database schema is created/migrated automatically on first boot.

### Make yourself a platform admin (optional)
The first signups are regular members. To mint invites from the in-app admin panel (instead
of the CLI) and manage users, promote your account:

```bash
docker compose exec app npm run -s start >/dev/null 2>&1 # (already running; skip)
docker compose exec app npx tsx server/scripts/promote-admin.ts your@email.com
```

## What's running

| Service | Purpose | Exposed? |
|---|---|---|
| `app` | Fastify server: serves the web UI **and** the `/api`; applies DB migrations on boot | Yes — host port `APP_PORT` (default **5174**) |
| `db`  | PostgreSQL 16 — all persistent data | **No** — internal to the compose network only |
| volume `doapp-db` | Postgres data directory on your host disk | local only |

Health check: `GET http://<host>:5174/health` returns `{ "ok": true }` when the app and DB
are up (used by the container healthcheck).

## Backup & restore

Everything is one Postgres database, so a backup is a single dump file.

```bash
# Backup -> ./backup.sql  (run on the host, in the repo dir)
docker compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql

# Restore into a fresh/empty database
cat backup.sql | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

(`$POSTGRES_USER` / `$POSTGRES_DB` default to `doapp` / `do_app` — match your `.env`.)
Store `backup.sql` wherever your retention policy requires; it never leaves your control.

## Upgrades

```bash
git pull
docker compose up -d --build
```

Migrations are forward-only and run automatically on boot; the server refuses to start if a
migration fails (so a bad upgrade won't half-apply). **Take a backup before upgrading.**

## Running without Docker (alternative)

You can run directly against any Postgres (local, Neon, Supabase, Railway, Dokploy DB):

```bash
npm ci
# set DATABASE_URL, SESSION_SECRET (and NODE_ENV=production) in .env
npm run build
npm run start        # migrates, then serves dist/ + /api on PORT (default 5174)
```

## Notes & current limitations

- **Air-gapped:** after the images are built/pulled once, the stack makes no outbound calls.
  To deploy on an isolated network, build the images on a connected machine and transfer
  them (e.g. `docker save` / `docker load`).
- **Concurrent same-board editing** is last-write-wins today (no real-time merge). Fine for
  typical small-team workflows; avoid two people editing the *same* board's text at the
  exact same moment until real-time sync ships.
- **Not yet included** (roadmap for regulated buyers): SSO (SAML/OIDC), audit logging,
  finer-grained RBAC. See [DATA_RESIDENCY.md](DATA_RESIDENCY.md).
- TLS: terminate HTTPS at a reverse proxy in front of the app (Caddy/Traefik/nginx) for
  production; the app sets Secure cookies when `NODE_ENV=production`.
