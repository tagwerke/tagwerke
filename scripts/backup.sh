#!/usr/bin/env bash
# Tagwerke backup — full pg_dump of the whole database, always.
#
#   ./scripts/backup.sh            # compose deployment (default)
#   ./scripts/backup.sh --direct   # non-Docker deployment: uses DATABASE_URL
#
# Produces in ./backups/ :
#   tagwerke-<UTC>.dump            pg_dump custom format (or .dump.age, see below)
#   tagwerke-<UTC>.counts.json     row count per table at dump time — the restore
#                                  drill (scripts/restore-drill.sh) checks a restored
#                                  copy against this file
#
# Encryption: set BACKUP_AGE_RECIPIENT in .env to an age public key ("age1...")
# and the dump is piped straight through `age` — plaintext never touches disk.
# The manifest contains only table names and row counts, so it stays plaintext.
#
# Retention: keeps the newest BACKUP_KEEP dumps locally (default 14) and deletes
# older ones. Off-site copies are yours to manage — see docs/self-hosting.md.
#
# The dump contains password hashes, 2FA secrets and session data: treat any
# unencrypted dump exactly like your live database.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE=compose
[ "${1:-}" = "--direct" ] && MODE=direct

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
PGUSER="${POSTGRES_USER:-tagwerke}"
PGDB="${POSTGRES_DB:-tagwerke}"
KEEP="${BACKUP_KEEP:-14}"
RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
# Where backups land (default ./backups). Point at a mounted disk, another
# folder, wherever — retention pruning applies per-directory.
BACKUP_DIR="${BACKUP_DIR:-backups}"

# Run a psql query / pg_dump against the deployment's database.
# tr strips the \r that psql emits on Windows hosts (harmless elsewhere).
run_psql() {
  if [ "$MODE" = compose ]; then
    docker compose exec -T db psql -U "$PGUSER" -d "$PGDB" -Atc "$1" | tr -d '\r'
  else
    psql "$DATABASE_URL" -Atc "$1" | tr -d '\r'
  fi
}
run_pg_dump() {
  if [ "$MODE" = compose ]; then
    docker compose exec -T db pg_dump -Fc -U "$PGUSER" "$PGDB"
  else
    pg_dump -Fc "$DATABASE_URL"
  fi
}

if [ "$MODE" = direct ] && [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: --direct needs DATABASE_URL set (in .env or the environment)." >&2
  exit 1
fi
if [ -n "$RECIPIENT" ] && ! command -v age >/dev/null 2>&1; then
  echo "ERROR: BACKUP_AGE_RECIPIENT is set but 'age' is not installed (https://age-encryption.org)." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
BASE="$BACKUP_DIR/tagwerke-$STAMP"

# ── Counts manifest ───────────────────────────────────────────────────────────
# Row count per table, captured immediately before the dump. Written one
# "table": count pair per line — the drill parses it without needing jq.
# On a busy server a write between this and pg_dump can shift a count by a row
# or two; schedule backups in a quiet window (cron at night) to keep the drill
# comparison exact.
PGDB="$(run_psql 'select current_database()')"
TABLES="$(run_psql "select tablename from pg_tables where schemaname='public' order by tablename")"
if [ -z "$TABLES" ]; then
  echo "ERROR: no tables found — is the database initialized?" >&2
  exit 1
fi
MIGRATIONS="$(run_psql 'select count(*) from drizzle.__drizzle_migrations')"

{
  printf '{\n'
  printf '  "generated_at": "%s",\n' "$STAMP"
  printf '  "database": "%s",\n' "$PGDB"
  printf '  "migrations": %s,\n' "$MIGRATIONS"
  printf '  "tables": {\n'
  first=1
  for t in $TABLES; do
    [ $first -eq 1 ] || printf ',\n'
    first=0
    printf '    "%s": %s' "$t" "$(run_psql "select count(*) from public.\"$t\"")"
  done
  printf '\n  }\n}\n'
} > "$BASE.counts.json"

# ── Dump ──────────────────────────────────────────────────────────────────────
if [ -n "$RECIPIENT" ]; then
  OUT="$BASE.dump.age"
  run_pg_dump | age -r "$RECIPIENT" > "$OUT"
else
  OUT="$BASE.dump"
  run_pg_dump > "$OUT"
fi

if [ ! -s "$OUT" ]; then
  echo "ERROR: dump is empty — backup FAILED." >&2
  rm -f "$OUT" "$BASE.counts.json"
  exit 1
fi

# ── Retention: keep the newest $KEEP dumps (and their manifests) ─────────────
{ ls -1t "$BACKUP_DIR"/tagwerke-*.dump "$BACKUP_DIR"/tagwerke-*.dump.age 2>/dev/null || true; } \
  | tail -n +"$((KEEP + 1))" \
  | while read -r old; do
      rm -f "$old" "${old%.dump.age}.counts.json" "${old%.dump}.counts.json"
      echo "pruned $old"
    done

echo "backup OK: $OUT ($(du -h "$OUT" | cut -f1)) + $BASE.counts.json"
echo "next: verify it restores — ./scripts/restore-drill.sh $OUT"
