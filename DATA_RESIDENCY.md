# Data Residency & Privacy — do-app

Plain-language statement of where your data lives and what leaves your server. This is
the document to hand to a security reviewer or attach to a DPA. It describes the
**self-hosted** deployment (`docker compose`, see [SELF_HOSTING.md](SELF_HOSTING.md)).

## Short version

**All of your data stays on the machine you run do-app on. Nothing is sent to do-app's
authors, to any analytics service, or to any third party. The application makes no
outbound network calls during normal operation.** If you run it on a server in your own
jurisdiction, your data is in your jurisdiction, under your legal control.

## Where data lives

- **Everything is in one PostgreSQL database** — users, sessions, boards/tabs, tasks,
  TODAY plans, snapshots, invites, board membership. There is no second datastore.
- In the Docker Compose setup, Postgres writes to a **local named volume**
  (`doapp-db`) on your host disk. It does not leave the box.
- The database container is **not published to the host network** (no `ports:` on the
  `db` service) — only the app container can reach it, over the private compose network.
- The app container holds **no persistent state** of its own; it can be destroyed and
  recreated freely. All durable data is in the Postgres volume.

## What crosses the network

- **Inbound:** browser → the app on the port you publish (default `5174`). Session
  auth is a signed, HttpOnly cookie; passwords are hashed with Argon2id and never stored
  or logged in plaintext.
- **Outbound: none required.** do-app contains no telemetry, no analytics, no
  "phone-home", no license check, and no third-party API calls. After the container
  images are pulled once, the stack **runs fully air-gapped**.
- The only time the network is used to reach the public internet is when you *first
  build/pull* the Docker images (`node`, `postgres`, npm packages). You can do this on a
  connected machine and move the images to an isolated network.

## Secrets

- `SESSION_SECRET` (cookie signing) and `POSTGRES_PASSWORD` live in your `.env` on the
  host. Keep `.env` out of version control (it is git-ignored). Rotating `SESSION_SECRET`
  invalidates existing sessions (everyone re-logs-in); it does not affect stored data.

## Accounts & access

- **Registration is closed by default.** New accounts require an invite code minted by an
  operator (`docker compose exec app npm run invite`). There is no open sign-up.
- Per-board access is role-based (viewer / editor / admin); a platform `admin` role mints
  invites and reaches the admin panel.

## Backup, restore, and portability

- Your data is a standard PostgreSQL database — back it up and move it with ordinary
  `pg_dump` / `pg_restore`. Exact commands are in [SELF_HOSTING.md](SELF_HOSTING.md#backup--restore).
- Because everything is one Postgres DB, a backup is a single dump file you control.

## Current limitations (honest)

- **No audit log, SSO/SAML/OIDC, or SCIM yet.** These are on the roadmap for regulated
  buyers; if your compliance process requires them, talk to us before deploying.
- **Encryption at rest** is whatever your host/volume provides (e.g. an encrypted disk);
  do-app does not add application-level field encryption.
- **Concurrent editing** of the same board by multiple people at the same moment is
  last-write-wins today (no real-time merge). Fine for typical small-team use; see
  [SELF_HOSTING.md](SELF_HOSTING.md) notes.
