# Self-hosting Tagwerke

Stand up your own private Tagwerke instance in a few minutes on a single machine. All data
stays on your server — see [data-residency.md](data-residency.md).

## Requirements

- A Linux host (a small VPS is plenty) or any machine with **Docker** + the **Docker
  Compose** plugin. Nothing else — no Node, no Postgres install needed on the host.
- ~1 GB RAM and ~2 GB disk to start.

## One-command install (~5 minutes)

On a clean Ubuntu/Debian server, as root:

```bash
curl -fsSL https://get.tagwerke.com | sudo sh
```

That's the whole install. The script checks/installs Docker (from Docker's official
repo, every command echoed), creates `/opt/tagwerke`, pulls the pinned release image,
generates `SESSION_SECRET` + `POSTGRES_PASSWORD` into a `chmod 600` `.env`, starts the
stack, waits for `/health`, and prints your first signup invite code with the URL.
Nothing is ever sent anywhere — see the trust notes below.

Common variants (all configuration is env vars):

```bash
# Production with automatic HTTPS (DNS for the domain must point at this server):
TAGWERKE_DOMAIN=tw.example.com curl -fsSL https://get.tagwerke.com | sudo sh

# No domain yet, but want real TLS on a public IP (opt-in, uses sslip.io DNS):
TAGWERKE_SSLIP=1 curl -fsSL https://get.tagwerke.com | sudo sh

# Also generate an age backup-encryption key (recommended reading first: below):
TAGWERKE_BACKUP_KEY=1 curl -fsSL https://get.tagwerke.com | sudo sh

# See exactly what it would do, without doing anything:
curl -fsSL https://get.tagwerke.com | sh -s -- --dry-run
```

Without a domain the app runs over plain **http** — login works (the session cookie is
only marked `Secure` on https), but traffic is unencrypted: fine for evaluation, not
for production. Re-run the installer with `TAGWERKE_DOMAIN=...` at any time to move an
existing install onto HTTPS — re-runs never touch your secrets or data.

**Trust notes, before you pipe anything to sh:** the script is
[`install/get.sh`](../install/get.sh) in this repository — `get.tagwerke.com` is a
redirect to the copy at the release tag, so the URL resolves to auditable repo bytes.
Prefer reading first? `curl -fsSL https://get.tagwerke.com -o install.sh && less
install.sh && sudo sh install.sh`. The app itself makes **no outbound calls**; the only
network the installer touches is pulling images, fetching the compose files, installing
Docker if absent, and — only if you chose TLS — Caddy talking to Let's Encrypt.

After install, everything lives in `/opt/tagwerke` and plain `docker compose` commands
work there (`ps`, `logs`, `down`). To upgrade: edit `TAGWERKE_VERSION` in
`/opt/tagwerke/.env`, then `docker compose pull && docker compose up -d` — take a
backup first. Prove your setup once with `scripts/installer-smoke.sh` (from a repo
checkout) or the backup drill below.

Prefer to see every moving part yourself? The manual path below is the same stack,
assembled by hand — and it is the recipe for **air-gapped** installs.

## Quick start — manual, from source (under 10 minutes)

```bash
# 1. Get the code
git clone <your-tagwerke-repo-url> tagwerke && cd tagwerke

# 2. Configure secrets
cp .env.example .env
#    Edit .env and set at least:
#      SESSION_SECRET      -> a long random string  (e.g. `openssl rand -base64 48`)
#      POSTGRES_PASSWORD   -> a strong database password
#    Optional:
#      ORG_NAME            -> workspace name shown in the app (default "Workspace")
#      APP_URL             -> public base URL, used in password-reset links
#    Email (password reset / 2FA) — point at Amazon SES SMTP in an EU region, or any SMTP.
#    If unset, reset emails are logged to the server console in dev and FAIL in production:
#      SMTP_HOST           -> e.g. email-smtp.eu-west-1.amazonaws.com
#      SMTP_PORT           -> 587 (STARTTLS) or 465 (set SMTP_SECURE=true)
#      SMTP_SECURE         -> "true" for port 465
#      SMTP_USER/SMTP_PASS -> SES SMTP credentials
#      MAIL_FROM           -> a verified sender address
#    All four are required together — SMTP_HOST with blank USER/PASS counts as unconfigured
#    (hosted relays reject unauthenticated mail); use SMTP_ALLOW_ANONYMOUS=true only for an
#    internal relay that needs no login.
#    Or send over the SES API instead, which needs no SMTP credentials at all (those can only
#    be minted by someone with IAM rights on the AWS account — a send-only access key cannot
#    speak SMTP). Setting AWS_SES_REGION switches to it:
#      AWS_SES_REGION      -> e.g. eu-west-1
#      AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY -> a key allowed to ses:SendEmail
#      MAIL_FROM           -> a verified SES identity
#    Verify either path with `npm run mail:test -- you@example.com`; with mail unconfigured,
#    POST /api/auth/forgot answers 503 instead of pretending to send.

# 3. Build and start (app + database)
docker compose up -d --build

# 4. Mint your first signup invite (registration is invite-only)
docker compose exec app npm run invite
#    -> prints an invite code. Copy it.

# 5. Open the app
#    http://<your-server>:5174   (or http://localhost:5174 locally)
#    Sign up with the invite code from step 4. You're in.

# 6. Backups are automatic — the app dumps its whole database to ./backups
#    daily, starting shortly after first boot. Two things stay yours:
#    (a) recommended: encrypt them — set BACKUP_AGE_RECIPIENT in .env
#        (~5 minutes, see "Backup & restore" below);
#    (b) copy ./backups off the server on your own schedule.
#    Then prove the whole loop once — boots a throwaway copy of the stack,
#    waits for its automatic backup, verifies it restores, cleans up (~3 min):
./scripts/selftest.sh
```

That's it. The database schema is created/migrated automatically on first boot.
Don't skip step 6's drill — a Tagwerke instance isn't production-ready until a
backup has been taken **and proven to restore**.

### Make yourself a platform admin (optional)

The first signups are regular members. To mint invites from the in-app admin panel (instead
of the CLI) and manage users, promote your account:

```bash
docker compose exec app npx tsx server/scripts/promote-admin.ts your@email.com
```

## What's running

| Service | Purpose | Exposed? |
| --- | --- | --- |
| `app` | Fastify server: serves the web UI **and** the `/api`; applies DB migrations on boot | Yes — host port `APP_PORT` (default **5174**) |
| `db` | PostgreSQL 17 — all persistent data | **No** — internal to the compose network only |
| volume `tagwerke-db` | Postgres data directory on your host disk | local only |

Health check: `GET http://<host>:5174/health` returns `{ "ok": true }` when the app and DB
are up (used by the container healthcheck).

## Backup & restore

Everything is one Postgres database, so a backup is a single dump file — always a **full**
dump of every table (including the audit log). A word of caution before the commands: the
dump contains password hashes, 2FA secrets, and session data. **An unencrypted backup is
exactly as sensitive as your live database** — encrypt it before it leaves the host.

### Automatic backups (built in, on by default)

The app backs itself up: a full dump of every table is written to `./backups/`
shortly after first boot and then daily, with the oldest pruned past `BACKUP_KEEP`
(default 14). There is nothing to configure and no cron to add. If backups ever
stop (misconfiguration, missing `pg_dump` on a non-Docker install), the server
logs an error on every hourly check — watch your logs.

Opt out with `BACKUP_DISABLED=true` **only** if you already run your own database
backup pipeline (pgBackRest, managed-Postgres snapshots, volume snapshots); the
server then reminds you on every boot that backups are your responsibility.

What the automatic job can't do for you: move the files **off the server** (see
retention below) and prove they restore (run the drill). Both stay in your hands
by design — nothing is ever uploaded anywhere.

### Taking a manual backup — `scripts/backup.sh`

Same artifacts as the automatic job, on demand — take one before risky changes,
or use it as your only mechanism when `BACKUP_DISABLED=true`:

```bash
./scripts/backup.sh            # compose deployment
./scripts/backup.sh --direct   # non-Docker deployment (uses DATABASE_URL)
```

Each run writes two files to `./backups/`:

- `tagwerke-<timestamp>.dump` — a `pg_dump` custom-format (`-Fc`) dump of the whole
  database (compressed; restore with `pg_restore`, selectively or in parallel);
- `tagwerke-<timestamp>.counts.json` — a manifest of per-table row counts captured at
  dump time, which the restore drill (below) verifies against.

**Encryption (recommended):** install [age](https://age-encryption.org), run
`age-keygen -o tagwerke-backup-key.txt` once, and set `BACKUP_AGE_RECIPIENT` in `.env`
to the printed public key. Backups are then piped straight through `age` — plaintext
never touches disk — and come out as `.dump.age`. Keep the secret-key file **off the
server** (password manager or offline copy); you only need it to run the drill or to
restore. If your organization has standardized on GPG instead, leave
`BACKUP_AGE_RECIPIENT` unset and encrypt the `.dump` file with your usual GPG workflow.

**Retention:** the script keeps the newest `BACKUP_KEEP` dumps locally (default 14) and
prunes older ones. Copy backups off the server on your own schedule — a reasonable
starting policy is *14 daily local, 8 weekly + 12 monthly off-site*, adjusted to your
retention obligations. For off-site storage under the strictest EU posture, prefer
EU-owned object storage (Hetzner, Scaleway, OVH); see the backups section of
[data-residency.md](data-residency.md) for why the provider's *ownership*, not just its
region, matters.

With automatic backups on (the default) there is nothing to schedule. If you set
`BACKUP_DISABLED=true` but still want dump files, cron the script yourself:

```cron
15 3 * * * cd /opt/tagwerke && ./scripts/backup.sh >> backups/backup.log 2>&1
```

### Verifying backups — `scripts/restore-drill.sh`

A backup you have never restored is a hope, not a backup. The drill restores a dump into
a throwaway Postgres container (never your live one) and asserts the result is complete:
every application table present, the migrations journal intact, and every row count
matching the manifest from dump time. Exit code 0 means the backup restores completely.

```bash
./scripts/restore-drill.sh backups/tagwerke-<timestamp>.dump      # or .dump.age
```

For encrypted dumps, set `BACKUP_AGE_IDENTITY` to the path of your age secret-key file.
Run the drill **after every upgrade and at least monthly** (it is cron-friendly — alert
on non-zero exit). If you ever dump with client tools *newer* than Postgres 17
(`--direct` mode with a v18 `pg_dump`, say), point the drill at a matching image:
`DRILL_PG_IMAGE=postgres:18-alpine ./scripts/restore-drill.sh …`.

There is also a one-command **self-test** that proves the entire loop on your machine
before you trust it with data: `./scripts/selftest.sh` boots a completely isolated
throwaway copy of the stack (own compose project, own volume, own backups folder,
port 5999 — it cannot touch a running Tagwerke), waits for its automatic backup,
drills it, and tears everything down. Exit 0 means install → automatic backup →
verified restore all work on your hardware. Run it once before go-live.

### Restoring into production

Restore is deliberately manual — it overwrites the live database:

```bash
docker compose stop app

# Plain dump:
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner < backups/tagwerke-<timestamp>.dump

# Encrypted dump: decrypt in-stream (plaintext never touches disk)
age -d -i /path/to/tagwerke-backup-key.txt backups/tagwerke-<timestamp>.dump.age \
  | docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --clean --if-exists --no-owner

docker compose start app   # boot re-verifies migrations against the restored schema
```

(`$POSTGRES_USER` / `$POSTGRES_DB` default to `tagwerke` / `tagwerke` — match your
`.env`.) After any production restore, run the drill against your next fresh backup.

Point-in-time recovery (WAL archiving) is beyond this guide; the database is standard
Postgres 17, so standard tooling (`pgBackRest`, `wal-g`) applies if you need it.

## Document storage (file uploads)

File upload is **off by default**. The rest of the app works normally without it; the upload
endpoints simply answer `503`, and the server log says which variables are missing at boot.

Turning it on means pointing Tagwerke at an **S3-compatible bucket**. It does not care which
one — the difference is a single URL:

| Where | `S3_ENDPOINT` | Notes |
|---|---|---|
| **Garage** | `http://garage:3900` | Self-hosted, lightweight, built for exactly this. **Recommended if you want nothing to leave your network.** |
| **MinIO** | `http://minio:9000` | Self-hosted, more widely known, heavier. |
| **Cloudflare R2** | `https://<account-id>.r2.cloudflarestorage.com` | Hosted. Set `S3_REGION=auto`. No egress fees. |
| **AWS S3** | `https://s3.<region>.amazonaws.com` | Hosted. |

```bash
# In .env
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=tagwerke-documents
S3_REGION=auto                 # 'auto' for R2; a real region elsewhere
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
# Path style works everywhere; virtual-host style needs per-bucket DNS. Leave this alone
# unless your provider requires otherwise.
S3_FORCE_PATH_STYLE=true

# Optional limits (bytes). Defaults: 100 MiB per file, 5 GiB per board.
MAX_UPLOAD_BYTES=104857600
BOARD_QUOTA_BYTES=5368709120
```

Create the bucket yourself — Tagwerke never creates one, so a typo in `S3_BUCKET` fails loudly
instead of silently writing into a new bucket. Restart the app and the boot log confirms it:

```
document storage ready — bucket "tagwerke-documents" at https://...
```

### Three things to get right

1. **Scope the credentials to this bucket only.** The access key in `.env` should not be able
   to list, read or delete any other bucket. On R2 that is an API token scoped to one bucket;
   on AWS it is an IAM policy naming one ARN.
2. **Your database backup no longer contains everything.** `pg_dump` captures each document's
   metadata but not its bytes. Restoring only the database gives you boards whose files 404.
   Back the bucket up too — provider versioning or lifecycle replication is usually enough —
   and add restoring it to your drill. (With uploads off, the dump is still complete.)
3. **Residency follows the bucket, not the app.** A hosted bucket makes that provider a
   sub-processor of your users' file contents, and a US-owned provider is reachable under the
   CLOUD Act even for an EU-region bucket. If that matters, run Garage or MinIO yourself. See
   [data-residency.md](data-residency.md#sub-processors).

### Deleting files

Deleting a document moves it to Trash; the bytes stay in the bucket so it can be restored.
Deleting a **board** removes its files from the bucket immediately. Trashed documents are
purged — object first, then row — by the retention command, alongside trashed tasks and old
audit rows:

```bash
docker compose exec app npm run prune-audit -- --dry   # report only
docker compose exec app npm run prune-audit            # audit > 12mo, trash > 30d
```

If an object cannot be deleted (bucket unreachable, credentials rotated), its row is kept so
the next run retries rather than losing track of the file. `npm run erase-user` likewise
deletes the files on any board it removes, and reports any it could not.


## Upgrades

Installer deployment (`/opt/tagwerke`): edit `TAGWERKE_VERSION` in `.env`, then

```bash
docker compose pull && docker compose up -d
```

Manual clone-and-compose deployment:

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

## Security & compliance features

- **SSO via OIDC** (Authorization Code + PKCE): configured in-app from the admin console —
  works with Keycloak, Authentik, Entra ID, Okta, or any standards-compliant IdP. New accounts
  are invite-gated (SSO signs existing users in; first-time creation consumes an invite), with
  an optional allowed-domain filter and an enforced-SSO mode (password login disabled, with a
  lockout-proof fallback). Local email/password auth always remains available as a
  deployment option — you are never forced into an external IdP.
- **Two-factor auth:** TOTP (authenticator apps) and **WebAuthn passkeys**.
- **Audit log:** append-only, covers every mutating API call, with field-level diffs for
  content edits. Admins can view and export it from the admin console. Retention pruning:
  `docker compose exec app npm run prune-audit` (default keeps 12 months; run it from cron
  until scheduled retention ships).
- **Per-object history** (task/board timelines) and **soft-delete with trash + restore**
  for tasks (30-day default purge).
- **Admin console** behind a sudo step-up (re-authentication for sensitive actions).

## Notes & current limitations

- **Air-gapped:** the app makes **no outbound calls by default** — no telemetry, no
  license checks. Two optional features do reach out *if you configure them*: SMTP (password
  reset email, to the server you specify) and OIDC SSO (to your IdP). Leave both
  unconfigured for a fully isolated deployment: after the images are built/pulled once, the
  stack runs air-gapped. To deploy on an isolated network, build the images on a connected
  machine and transfer them (e.g. `docker save` / `docker load`).
- **Concurrent same-board editing** is last-write-wins today (no real-time merge). Fine for
  typical small-team workflows; avoid two people editing the *same* board's text at the
  exact same moment until real-time sync ships.
- **Not yet included** (roadmap): SAML, SCIM provisioning, custom roles beyond the built-in
  viewer/editor/admin. See [data-residency.md](data-residency.md).
- TLS: terminate HTTPS at a reverse proxy in front of the app (Caddy/Traefik/nginx) for
  production; the app sets Secure cookies when `NODE_ENV=production`.
