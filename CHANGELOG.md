# Changelog

All notable changes to do-app are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (0.x: minor bumps may include breaking
changes, called out explicitly). Database migrations are forward-only and apply
automatically on boot — always take a backup before upgrading.

## [Unreleased]

## [0.1.0] — 2026-07-18 (planned first public release)

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
- **OIDC SSO** (Authorization Code + PKCE), configured in-app: domain-gated JIT
  provisioning, enforced-SSO mode with lockout-proof fallback.
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
- Docs: self-hosting guide (backup/restore, upgrades) and data-residency statement.

### Known limitations

- No real-time multi-user sync: other users' edits appear on refresh; concurrent editing
  of the same board text is last-write-wins.
- No SAML, no SCIM, no importers, no public API tokens/webhooks, no notifications yet.
- Audit retention pruning is a manual command (schedule it via cron).
