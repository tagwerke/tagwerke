# Contributing to Tagwerke

Thanks for your interest! A few ground rules keep contributions smooth for everyone.

## Developer Certificate of Origin (DCO) — required

Tagwerke is licensed under the Business Source License 1.1 (converting to Apache 2.0 per
release — see [LICENSE](LICENSE)). To keep the project's licensing unambiguous, every
commit must be **signed off** under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/):

```bash
git commit -s -m "your message"
```

The `-s` flag adds a `Signed-off-by: Your Name <you@example.com>` line, certifying that
you wrote the contribution (or have the right to submit it) and that it may be
distributed under the project's license. PRs with unsigned commits can't be merged.

## Before you open a PR

1. **Open an issue first** for anything beyond a small fix — the roadmap is opinionated
   (text-first, reference-not-copy, two-container deploy) and we'd rather discuss before
   you invest time. Features that add a required service/container to the stack will be
   declined; operational simplicity is a core product constraint.
2. **Security issues:** never as a PR or public issue — see [SECURITY.md](SECURITY.md).

## Development setup

```bash
npm ci
cp .env.example .env      # set DATABASE_URL to a local Postgres, SESSION_SECRET
npm run dev               # Fastify server (tsx watch) + Vite dev server
```

Checks that must pass:

```bash
npm run build             # tsc -b + vite build
npm run typecheck:server
npm run lint
```

## Style

- Match the surrounding code — naming, comment density, idioms.
- Database changes go through Drizzle migrations (`npm run db:generate`); migrations are
  forward-only.
- Keep PRs focused; one change per PR.
