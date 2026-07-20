# Changelog

All notable changes to Tagwerke are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (0.x: minor bumps may include breaking
changes, called out explicitly). Database migrations are forward-only and apply
automatically on boot — always take a backup before upgrading.

## [Unreleased]

## [0.2.0] — 2026-07-20

Second public release. The headline is **collaboration**: Tagwerke is now real-time and
no longer reads as a single-player tool. Database migrations (through `0024`) apply
automatically on boot — **take a backup before upgrading** (the built-in daily backup or
`scripts/backup.sh`).

### Added

- **Keystroke-level co-editing (Yjs CRDT)** — two people edit the same board's text at
  once with character-granular merge and live cursors; no locks, no last-write-wins loss.
  One authoritative `Y.Doc` per board over the app WebSocket; `docJSON` is now a derived
  snapshot.
- **Live updates** — task/entity changes and **board-membership changes** (add/remove/role)
  fan out over the socket, so peers and the affected user's sidebar update without a refresh.
- **Notifications** — presence-routed: a live in-app bell when you're connected, and **web
  push** to your phone/desktop when you're away (task assigned, review requested, approved,
  added to a board). Opt-in per device; in-app is always on. The `get.sh` installer
  auto-generates the required VAPID keypair.
- **Calendar** — a `/calendar` route with a day/week grid: drag to move, drag-edge to
  resize, cross-day drag, an inline event editor, a sidebar agenda, and meeting RSVP.

### Changed

- **Tasks are now first-class entities** — the database row is the single source of truth
  for a task's text, status, and existence; the board document holds prose plus id-only
  references, and the server reconciles the two on every change. This structurally removes
  a class of bugs where a restored or dropped task failed to reappear on the board.
- **The time-block Planner was retired**, replaced by the calendar as the time-oriented view.

### Fixed

- New-board text/tasks could be lost on the first refresh due to a membership race on the
  document-join; the client now retries a rejected join, and first-session state persists
  durably.

### Known limitations

- No comments on tasks yet, and no importers (CSV/Jira) — both are planned next.
- No SAML, no SCIM, no public API tokens/webhooks.
- Audit retention pruning is still a manual command (schedule it via cron).

## [0.1.0] — 2026-07-07 (first public release)

First public, versioned release.

### Core

- Text-first boards: tasks are typed as text in a document editor, with inline
  `/due`, `/status`, `/p1` slash commands and `@mention` assignment from real board
  members.
- Reference-not-copy data model: one canonical task record; the **Planner** shows live
  views (time blocks) of your boards via references and filters — never copies.
- Boards, projects, calendar events (with recurrence), per-board sharing with
  viewer/editor/admin roles.
- Search palette (Ctrl/Cmd+K).
- Installable **PWA with offline support**: durable IndexedDB write outbox that replays
  on reconnect, offline snapshot so a fully offline reload keeps your work.

### Security & compliance

- Invite-only registration; Argon2id password hashing; signed HttpOnly session cookies;
  rate-limited auth with lockout.
- **OIDC SSO** (Authorization Code + PKCE), configured in-app: invite-gated account creation
  with an optional allowed-domain filter, enforced-SSO mode with lockout-proof fallback.
- **TOTP 2FA** and **WebAuthn passkeys**; password reset via branded email (SMTP).
- **Append-only audit log** with field-level diffs for content edits; admin view +
  export; per-object task/board history; retention prune command.
- **Soft-delete** for tasks with trash + restore (30-day default purge).
- Admin console (users, invites, 2FA/passkey resets, roles) behind a sudo step-up.
- GDPR operator tooling: full per-user JSON export and erasure commands.

### Deployment

- Two-container `docker compose` stack (app + Postgres): named volume, healthchecks,
  `restart: unless-stopped`, `/health` endpoint, migrations auto-apply on boot.
- No telemetry, no phone-home; air-gap-clean in the default configuration.
- **Automatic daily backups, on by default**: the server dumps its whole database
  (full `pg_dump -Fc`, every table, with a row-count manifest and optional age
  encryption) to a host-mounted `./backups/` folder — separate from the database
  volume — and prunes past `BACKUP_KEEP`. No setup, no cron; opt out with
  `BACKUP_DISABLED=true`. Nothing is ever uploaded anywhere.
- Backup tooling: `scripts/backup.sh` takes the same backup on demand;
  `scripts/restore-drill.sh` restores any dump into a throwaway container and
  verifies completeness (tables, migrations journal, row counts) — cron-friendly,
  exits non-zero on a bad backup; `scripts/selftest.sh` proves the whole loop
  (fresh install → automatic backup → verified restore) in one command on an
  isolated throwaway stack.
- Docs: self-hosting guide (backup/restore, upgrades) and data-residency statement.

### Known limitations

- No real-time multi-user sync: other users' edits appear on refresh; concurrent editing
  of the same board text is last-write-wins.
- No SAML, no SCIM, no importers, no public API tokens/webhooks, no notifications yet.
- Audit retention pruning is a manual command (schedule it via cron).
