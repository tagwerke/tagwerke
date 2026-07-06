#!/usr/bin/env bash
# Tagwerke self-test — prove the whole backup loop on this machine, one command:
#
#   ./scripts/selftest.sh
#
# Boots a throwaway copy of the real compose stack (own project name, own
# database volume, own backups folder, port 5999 — it cannot touch a running
# Tagwerke, your data, or your ./backups), then:
#
#   1. waits for the app to come up healthy on a fresh database,
#   2. waits for the built-in automatic backup to fire (~30s after boot),
#   3. runs scripts/restore-drill.sh against that backup,
#   4. tears everything down, volume included.
#
# Exit 0 = install → automatic backup → verified restore all work HERE, on your
# hardware. Run it before first go-live and after upgrades. ~2-5 min (first run
# builds the image). Override the port with SELFTEST_PORT if 5999 is taken.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=tagwerke-selftest
TESTDIR=.selftest
PORT="${SELFTEST_PORT:-5999}"

compose() {
  POSTGRES_PASSWORD=selftest-only-not-a-secret \
  SESSION_SECRET=selftest-only-not-a-secret-selftest-only \
  APP_PORT="$PORT" \
  docker compose -p "$PROJECT" -f docker-compose.yml -f "$TESTDIR/override.yml" "$@"
}

cleanup() {
  echo "cleaning up test stack..."
  compose down -v >/dev/null 2>&1 || true
  rm -rf "$TESTDIR"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required." >&2; exit 1; }

# Isolated backups dir: the override remounts /app/backups here, so the test
# never mixes with (or is skipped because of) real backups in ./backups.
rm -rf "$TESTDIR"
mkdir -p "$TESTDIR/backups"
cat > "$TESTDIR/override.yml" <<'EOF'
services:
  app:
    volumes:
      - ./.selftest/backups:/app/backups
EOF

echo "[1/4] building + starting throwaway stack (project: $PROJECT, port: $PORT)..."
compose up -d --build --quiet-pull

echo "[2/4] waiting for app health..."
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && { echo "ERROR: app never became healthy — logs:" >&2; compose logs app | tail -30 >&2; exit 1; }
  sleep 2
done
echo "  ok: /health is green on a fresh database"

echo "[3/4] waiting for the automatic backup (fires ~30s after boot)..."
DUMP=""
for i in $(seq 1 45); do
  DUMP="$(ls "$TESTDIR"/backups/tagwerke-*.dump 2>/dev/null | head -1 || true)"
  [ -n "$DUMP" ] && break
  [ "$i" = 45 ] && { echo "ERROR: no automatic backup after 90s — logs:" >&2; compose logs app | tail -30 >&2; exit 1; }
  sleep 2
done
echo "  ok: automatic backup written: $DUMP"

echo "[4/4] restore drill on the automatic backup..."
bash scripts/restore-drill.sh "$DUMP"

echo
echo "SELF-TEST PASSED — on this machine: fresh install boots, backs itself up"
echo "automatically, and that backup provably restores."
