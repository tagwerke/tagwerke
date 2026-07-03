# do-app

**The self-hosted team workspace where work is text-first and lives once.** Type your
tasks like text, reference them everywhere — boards, the day planner, search all show the
same item, never a copy — and keep every byte on your own server, in your own
jurisdiction.

*Linear's speed and Notion's references — on your own server.*

- **Text-first:** boards are documents. Type tasks, then `/due friday`, `/p1`,
  `@teammate` inline. No forms, no field-by-field data entry.
- **Reference, not copy:** a task is one canonical record. The Planner shows a live view
  of your boards — edit in one place, it's current everywhere. Nothing drifts.
- **Genuinely self-hosted:** two containers (the app + Postgres), one command, ~1 GB RAM.
  No telemetry, no phone-home, air-gap-clean by default. Your data never leaves your box.
- **Compliance-ready:** OIDC SSO (free, configured in-app), TOTP 2FA + passkeys,
  append-only audit log with field-level diffs, per-object history, soft-delete + trash,
  sudo-gated admin console, GDPR export/erase tooling.
- **Works offline:** installable PWA with a durable write outbox — edit on the train,
  it syncs when you're back.

## Quick start

```bash
git clone <repo-url> do-app && cd do-app
cp .env.example .env        # set SESSION_SECRET + POSTGRES_PASSWORD
docker compose up -d --build
docker compose exec app npm run invite   # mint your first signup invite
# open http://localhost:5174 and sign up with the invite code
```

Full guide (backup/restore, upgrades, SSO, running without Docker):
[docs/self-hosting.md](docs/self-hosting.md).

## Documentation

| Doc | What it covers |
|---|---|
| [docs/self-hosting.md](docs/self-hosting.md) | Install, upgrade, backup/restore, security features, limitations |
| [docs/data-residency.md](docs/data-residency.md) | Where data lives, what crosses the network, sub-processors (none), GDPR tooling — the document to hand to your security reviewer |
| [SECURITY.md](SECURITY.md) | Reporting vulnerabilities, security posture |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute (DCO required) |

## Status & honest limitations

do-app is young and moving fast. Today: no real-time multi-user sync (edits appear on
refresh; concurrent same-board editing is last-write-wins), no SAML/SCIM, no importers
yet. See [docs/self-hosting.md](docs/self-hosting.md#notes--current-limitations) for the
full list — we'd rather you read it here than discover it in week two.

## Licensing

do-app is **source-available** under the Business Source License 1.1 (see
[LICENSE](LICENSE)):

- **Free:** self-host it in production for your own organization — all features,
  including SSO and the audit log. No seat limits, no feature gates on what's here today.
- **Not allowed:** offering do-app to third parties as a hosted/managed service.
- **Becomes open source:** each version automatically converts to **Apache 2.0** four
  years after release.

For hosting/OEM or enterprise arrangements (SAML, SCIM, air-gap support, SLA — as they
ship), contact the address in [LICENSE](LICENSE).

## Development

```bash
npm ci
npm run dev          # server (tsx watch) + Vite, needs DATABASE_URL in .env
npm run build        # typecheck + production build
npm run lint
```
