# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**:

- Email: **kirill.k.knyazev@gmail.com** with subject line `[SECURITY] do-app`
- Or use GitHub's private vulnerability reporting ("Report a vulnerability" under the
  Security tab) once the repository is public.

Please do **not** open a public issue for security reports.

What to expect:

- **Acknowledgement within 72 hours.**
- An assessment and remediation plan within 7 days for confirmed issues.
- A fix released as a patch version, credited to you (unless you prefer otherwise), with
  a GitHub Security Advisory for anything affecting self-hosted deployments.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (latest minor) | Yes |
| Older | Upgrade to latest; migrations are forward-only and automatic |

## Security posture (summary for reviewers)

- Passwords hashed with **Argon2id**; sessions are signed, HttpOnly, SameSite cookies;
  auth endpoints are rate-limited with account lockout.
- **OIDC SSO** uses Authorization Code + **PKCE** with state/nonce checks; enforced-SSO
  mode can disable password login (with a lockout-proof recovery path).
- **TOTP 2FA** and **WebAuthn passkeys** supported.
- Sensitive admin actions require a **sudo step-up** (fresh re-authentication).
- **Append-only audit log** over every mutating API call, with field-level diffs and a
  secrets denylist; admin export; configurable retention.
- **No telemetry, no phone-home, no third-party API calls** in the default
  configuration; optional outbound is limited to the SMTP server and OIDC IdP *you*
  configure. See [docs/data-residency.md](docs/data-residency.md).
- Encryption in transit is terminated at your reverse proxy (TLS); encryption at rest is
  provided by your host/volume. do-app does not add application-level field encryption.

## Hardening recommendations

- Run behind a TLS-terminating reverse proxy; set `NODE_ENV=production` (Secure cookies).
- Keep Postgres unpublished (the provided compose file already does this).
- Take a `pg_dump` backup before every upgrade
  ([docs/self-hosting.md](docs/self-hosting.md#backup--restore)).
- Schedule `npm run prune-audit` via cron to enforce your audit-retention policy.
