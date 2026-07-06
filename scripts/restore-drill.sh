#!/usr/bin/env bash
# Tagwerke restore drill — prove a backup actually restores, without going near
# your live stack.
#
#   ./scripts/restore-drill.sh backups/tagwerke-<UTC>.dump[.age]
#
# Restores the dump into a throwaway Postgres container (no volume, no published
# port, not on the compose network) and asserts the result is complete:
#
#   1. every application table exists (a hardcoded list — catches a dump AND
#      manifest that were both produced from a broken source),
#   2. the migrations journal is present and matches the manifest,
#   3. every row count matches the counts manifest written at dump time.
#
# Exit 0 = the backup restores completely. Non-zero = treat that backup as bad.
# Run it after every upgrade and at least monthly (cron-friendly).
#
# Encrypted dumps: set BACKUP_AGE_IDENTITY to your age identity (secret key)
# file; the dump is decrypted in a stream — plaintext never touches disk.
#
# This is a verification tool only. It never touches the live db container or
# volume; restoring into production is a manual procedure — see
# docs/self-hosting.md "Backup & restore".
set -euo pipefail

cd "$(dirname "$0")/.."

DUMP="${1:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "usage: $0 backups/tagwerke-<timestamp>.dump[.age]" >&2
  exit 2
fi

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# Every table the application schema defines (server/db/schema.ts). If you add a
# table, add it here — the live-verify step in CI/dev will catch the drift.
REQUIRED_TABLES="org users invites sessions projects tabs tasks board_members
events event_attendance time_blocks webauthn_credentials password_reset_tokens
board_activity audit_log"

MANIFEST="${2:-}"
if [ -z "$MANIFEST" ]; then
  MANIFEST="${DUMP%.dump.age}"; MANIFEST="${MANIFEST%.dump}.counts.json"
fi

FAILURES=0
fail() { echo "FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }
ok()   { echo "  ok: $1"; }

# ── Throwaway container ───────────────────────────────────────────────────────
NAME="tagwerke-restore-drill-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Must be >= the Postgres that made the dump (compose ships postgres:17).
PG_IMAGE="${DRILL_PG_IMAGE:-postgres:17-alpine}"

echo "starting scratch postgres ($NAME, $PG_IMAGE)..."
docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill \
  "$PG_IMAGE" >/dev/null

for i in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d drill >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && { echo "ERROR: scratch postgres did not become ready" >&2; exit 1; }
  sleep 1
done

# tr strips the \r that docker/psql emit on Windows hosts (harmless elsewhere).
q() { docker exec "$NAME" psql -h 127.0.0.1 -U postgres -d drill -Atc "$1" | tr -d '\r'; }

# ── Restore ───────────────────────────────────────────────────────────────────
echo "restoring $DUMP ..."
case "$DUMP" in
  *.age)
    if [ -z "${BACKUP_AGE_IDENTITY:-}" ] || [ ! -f "${BACKUP_AGE_IDENTITY:-}" ]; then
      echo "ERROR: encrypted dump — set BACKUP_AGE_IDENTITY to your age identity file." >&2
      exit 1
    fi
    age -d -i "$BACKUP_AGE_IDENTITY" "$DUMP" \
      | docker exec -i "$NAME" pg_restore -h 127.0.0.1 -U postgres -d drill --no-owner --no-privileges
    ;;
  *)
    docker exec -i "$NAME" pg_restore -h 127.0.0.1 -U postgres -d drill --no-owner --no-privileges < "$DUMP"
    ;;
esac
ok "pg_restore completed without errors"

# ── 1. Required tables ────────────────────────────────────────────────────────
for t in $REQUIRED_TABLES; do
  if [ "$(q "select count(*) from pg_tables where schemaname='public' and tablename='$t'")" = 1 ]; then
    ok "table $t present"
  else
    fail "table $t MISSING from restored database"
  fi
done

# ── 2. Migrations journal ─────────────────────────────────────────────────────
RESTORED_MIGRATIONS="$(q "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo MISSING)"
if [ "$RESTORED_MIGRATIONS" = MISSING ]; then
  fail "migrations journal (drizzle.__drizzle_migrations) missing — dump did not include the drizzle schema"
else
  ok "migrations journal present ($RESTORED_MIGRATIONS applied)"
fi

# ── 3. Row counts vs the manifest ─────────────────────────────────────────────
if [ ! -f "$MANIFEST" ]; then
  echo "WARN: no counts manifest at $MANIFEST — skipping row-count verification." >&2
  echo "      (Backups made by scripts/backup.sh always have one.)" >&2
else
  echo "checking row counts against $MANIFEST ..."
  MANIFEST_MIGRATIONS="$(sed -n 's/^ *"migrations": *\([0-9]*\),*$/\1/p' "$MANIFEST")"
  if [ -n "$MANIFEST_MIGRATIONS" ] && [ "$RESTORED_MIGRATIONS" != MISSING ] \
     && [ "$RESTORED_MIGRATIONS" != "$MANIFEST_MIGRATIONS" ]; then
    fail "migrations: manifest says $MANIFEST_MIGRATIONS, restored has $RESTORED_MIGRATIONS"
  fi
  # Manifest table lines look like:  "tablename": 123
  sed -n 's/^ *"\([a-z_]*\)": *\([0-9]*\),*$/\1 \2/p' "$MANIFEST" \
    | grep -v '^migrations ' \
    | while read -r t expected; do
        actual="$(q "select count(*) from public.\"$t\"" 2>/dev/null || echo MISSING)"
        if [ "$actual" = "$expected" ]; then
          ok "$t: $actual rows"
        else
          echo "FAIL: $t: expected $expected rows, restored has $actual" >&2
          # subshell can't bump $FAILURES — flag via file
          touch "${TMPDIR:-/tmp}/tagwerke-drill-count-failure-$$"
        fi
      done
  if [ -f "${TMPDIR:-/tmp}/tagwerke-drill-count-failure-$$" ]; then
    rm -f "${TMPDIR:-/tmp}/tagwerke-drill-count-failure-$$"
    FAILURES=$((FAILURES + 1))
  fi
fi

# ── Verdict ───────────────────────────────────────────────────────────────────
echo
if [ "$FAILURES" -gt 0 ]; then
  echo "RESTORE DRILL FAILED ($FAILURES problem(s)) — do NOT trust this backup." >&2
  exit 1
fi
echo "RESTORE DRILL PASSED — $DUMP restores completely."
