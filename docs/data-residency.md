# Data Residency & Privacy — Tagwerke

Plain-language statement of where your data lives and what leaves your server. This is
the document to hand to a security reviewer or attach to a DPA. It describes the
**self-hosted** deployment (`docker compose`, see [self-hosting.md](self-hosting.md)).

## Short version

**All of your data stays on the machine you run Tagwerke on. Nothing is sent to Tagwerke's
authors, to any analytics service, or to any third party. The application makes no
outbound network calls during normal operation** — with three optional, self-configured
exceptions (your SMTP server, your OIDC identity provider, and the object-storage bucket
used for file uploads, if you enable them; see below). Each one talks only to an endpoint
**you** choose: point the bucket at storage you run and nothing leaves your infrastructure
at all. If you run it on a server in your own jurisdiction, your data is in your
jurisdiction, under your legal control.

## Where data lives

- **Everything is in one PostgreSQL database** — users, sessions, boards/tabs, tasks,
  planner time blocks, calendar events, invites, board membership, the audit log, and
  passkey credentials.
- **Uploaded files are the one exception, and only if you enable them.** Set `S3_*` and the
  BYTES of uploaded documents go to the S3-compatible bucket you configure; the database
  keeps only the metadata row (filename, size, type, who uploaded it, which board). With
  `S3_*` unset — the default — file upload is off entirely and Postgres really is the only
  datastore. See [self-hosting.md](self-hosting.md#document-storage-file-uploads).
- In the Docker Compose setup, Postgres writes to a **local named volume**
  (`tagwerke-db`) on your host disk. It does not leave the box.
- The database container is **not published to the host network** (no `ports:` on the
  `db` service) — only the app container can reach it, over the private compose network.
- The app container holds **no persistent state** of its own; it can be destroyed and
  recreated freely. All durable data is in the Postgres volume.

## What crosses the network

- **Inbound:** browser → the app on the port you publish (default `5174`). Session
  auth is a signed, HttpOnly cookie; passwords are hashed with Argon2id and never stored
  or logged in plaintext.
- **Outbound: none required.** Tagwerke contains no telemetry, no analytics, no
  "phone-home", no license check, and no third-party API calls. After the container
  images are pulled once, the stack **runs fully air-gapped** in its default
  configuration.
- **Optional outbound, only if you enable it:** (1) **SMTP** — password-reset emails go
  to the mail server *you* configure (`SMTP_HOST`); (2) **OIDC SSO** — login redirects
  and token exchange go to the identity provider *you* configure from the admin console;
  (3) **Object storage** — if `S3_*` is set, uploaded files are written to and read from
  the bucket endpoint *you* configure. All three are off by default. SMTP and OIDC send no
  task/board content anywhere; object storage, by its nature, holds the file contents your
  users upload, which is why the endpoint is yours to choose. A self-hosted **Garage** or
  **MinIO** on your own network keeps this inside your perimeter; a hosted bucket
  (Cloudflare R2, AWS S3) makes that provider a sub-processor — see below.
- The only other time the network reaches the public internet is when you *first
  build/pull* the Docker images (`node`, `postgres`, npm packages). You can do this on a
  connected machine and move the images to an isolated network.

## Secrets

- `SESSION_SECRET` (cookie signing) and `POSTGRES_PASSWORD` live in your `.env` on the
  host. Keep `.env` out of version control (it is git-ignored). Rotating `SESSION_SECRET`
  invalidates existing sessions (everyone re-logs-in); it does not affect stored data.

## Accounts & access

- **Registration is closed by default.** Every new account requires an invite code minted by
  an operator (`docker compose exec app npm run invite`) — whether the user signs up with a
  password or via OIDC SSO. SSO signs existing users in without a code; creating a *new*
  account through SSO consumes an invite just like password sign-up. An optional allowed-domain
  filter can further restrict SSO. There is no open sign-up.
- **Authentication:** local email/password (Argon2id) with optional TOTP 2FA and WebAuthn
  passkeys, and/or OIDC SSO (Authorization Code + PKCE) against your IdP, including an
  enforced-SSO mode that disables password login.
- Per-board access is role-based (viewer / editor / admin); a platform `admin` role mints
  invites and reaches the admin console, which is additionally protected by a sudo
  step-up (fresh re-authentication).
- **Audit log:** every mutating API call is recorded in an append-only log with
  field-level diffs for content edits; admins can review and export it. Per-object
  history is visible in-app. Retention is configurable via a prune command
  (12-month default).

## Backup, restore, and portability

- **If you enable file uploads, your database backup is no longer the whole instance.**
  `pg_dump` captures every document's metadata row but not its bytes, which live in your
  bucket. A restore therefore brings back boards whose files 404 until the bucket is
  restored too. **Back the bucket up yourself** (most providers offer versioning or
  lifecycle replication), and add that step to your restore drill. With `S3_*` unset there
  is nothing extra to do — the dump is complete.
- Your data is a standard PostgreSQL database — back it up and move it with ordinary
  `pg_dump` / `pg_restore`. **Automatic daily backups are built in and on by default**
  (full dump of every table, written only to a local folder on your server, optionally
  age-encrypted); `scripts/backup.sh` takes the same backup on demand and
  `scripts/restore-drill.sh` proves any backup restores. Details in
  [self-hosting.md](self-hosting.md#backup--restore).
- **Backups are produced and stored entirely by you.** Tagwerke ships the tooling but is
  never in the data path: the backup script uploads nothing, phones nothing home, and we
  have no access to your dumps. Backups therefore inherit the residency guarantee of
  wherever *you* put them.
- **Choose off-site storage by ownership, not just region.** A US-owned provider (AWS,
  Google, Cloudflare) is subject to the US CLOUD Act even when the bucket is in an EU
  region — a US authority can compel disclosure. If your posture requires data to stay
  under EU jurisdiction, use EU-owned storage (Hetzner, Scaleway, OVH) or your own
  infrastructure. Encrypting backups with `age` (supported natively by the backup
  script) reduces the exposure either way, since the provider only ever holds
  ciphertext.
- **Backups and the right to erasure (Art. 17):** `npm run erase-user` removes a person
  from the live database, but they remain in backups taken before the erasure until
  those age out of your retention window. This is standard and accepted practice —
  provided your retention window is finite and stated in your records of processing,
  and backups are not restored in a way that resurrects erased data (after any
  production restore, re-run erasures performed since that backup was taken).
- Per-user GDPR tooling exists as operator commands: `npm run export-user` (full JSON
  export, Art. 20) and `npm run erase-user` (erasure, Art. 17).

## Sub-processors

None by design. Tagwerke's authors process none of your data — you are the operator. The
only parties that touch data in a self-hosted deployment are the ones **you** choose to
configure: your SMTP provider (reset emails: recipient addresses only), your OIDC identity
provider (authentication identities only), and — if you enable file uploads — your object
storage provider.

**Object storage deserves particular attention in a DPA.** Unlike the other two, it holds
the actual contents of files your users upload, not just addresses or identities. If you
point `S3_ENDPOINT` at a hosted service (Cloudflare R2, AWS S3, Backblaze), that provider
becomes a sub-processor of the file contents and must appear in your records of
processing. The same CLOUD Act reasoning as backups applies: a US-owned provider is
reachable by US authorities even for an EU-region bucket. To have **no** sub-processor for
file contents, run [Garage](https://garagehq.deuxfleurs.fr/) or MinIO on your own
infrastructure and point `S3_ENDPOINT` at it — the application cannot tell the difference,
and nothing leaves your network.

## Current limitations (honest)

- **No SAML or SCIM yet.** OIDC SSO, TOTP 2FA, passkeys, and audit logging are included
  (see above). If your compliance process requires SAML or SCIM provisioning
  specifically, talk to us before deploying.
- **Encryption at rest** is whatever your host/volume provides (e.g. an encrypted disk);
  Tagwerke does not add application-level field encryption. Encryption in transit is your
  reverse proxy's TLS (see [self-hosting.md](self-hosting.md)).
- **Concurrent editing** of the same board by multiple people at the same moment is
  last-write-wins today (no real-time merge). Fine for typical small-team use; see
  [self-hosting.md](self-hosting.md) notes.
- **Audit retention pruning is a manual command** (`npm run prune-audit`) — schedule it
  from cron; in-app scheduled retention is on the roadmap.
