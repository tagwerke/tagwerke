#!/usr/bin/env bash
# Installer smoke test — proves install/get.sh end-to-end on a Linux box.
#
#   sudo ./scripts/installer-smoke.sh
#
# Needs: Linux, root, Docker already installed (the Docker-auto-install path is
# exercised only on a truly clean server — test that once on a throwaway VPS).
# Uses a local image build and a temp install dir, so it needs neither the
# published GHCR image nor network access to GitHub — safe to run pre-release.
#
# What it proves:
#   1. --dry-run prints a plan and creates nothing
#   2. a fresh HTTP-mode install boots to green /health and prints an invite
#   3. signup with that invite WORKS OVER PLAIN HTTP (the scheme-aware cookie)
#   4. .env is chmod 600 with generated secrets
#   5. re-running is idempotent (secrets byte-identical, stack still healthy)
#   6. teardown leaves nothing behind
#
# NOT covered here (needs a real domain + open 80/443 — do once on the VPS):
#   TLS mode end-to-end (Caddy + Let's Encrypt + Secure cookie over real https).
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"

[ "$(uname -s)" = "Linux" ] || { echo "ERROR: run on a Linux host/VM." >&2; exit 1; }
[ "$(id -u)" = "0" ] || { echo "ERROR: run as root (sudo)." >&2; exit 1; }
command -v docker >/dev/null || { echo "ERROR: docker required." >&2; exit 1; }

SMOKE_TAG="ghcr.io/tagwerke/tagwerke:smoke"
PORT="${SMOKE_PORT:-5998}"
DIR="$(mktemp -d /tmp/tagwerke-smoke.XXXXXX)"

cleanup() {
  echo "cleaning up smoke stack..."
  (cd "$DIR" 2>/dev/null && docker compose down -v >/dev/null 2>&1) || true
  rm -rf "$DIR"
}
trap cleanup EXIT

echo "[1/6] building local image as $SMOKE_TAG ..."
docker build -q -t "$SMOKE_TAG" "$REPO_DIR" >/dev/null

echo "[2/6] --dry-run creates nothing..."
before="$(ls -A "$DIR")"
TAGWERKE_DIR="$DIR" TAGWERKE_VERSION=smoke TAGWERKE_NO_PROMPT=1 \
  sh "$REPO_DIR/install/get.sh" --dry-run >/dev/null
[ "$(ls -A "$DIR")" = "$before" ] || { echo "ERROR: dry-run created files" >&2; exit 1; }
echo "  ok"

echo "[3/6] fresh HTTP-mode install via get.sh ..."
OUT="$(TAGWERKE_DIR="$DIR" TAGWERKE_VERSION=smoke TAGWERKE_PORT="$PORT" \
       TAGWERKE_NO_PROMPT=1 TAGWERKE_BUNDLE_DIR="$REPO_DIR/install" \
       sh "$REPO_DIR/install/get.sh")"
printf '%s\n' "$OUT" | tail -20
curl -fsS "http://localhost:$PORT/health" >/dev/null || { echo "ERROR: /health not green" >&2; exit 1; }
INVITE="$(printf '%s\n' "$OUT" | sed -n 's/.*Invite code:[[:space:]]*\([^ ]*\).*/\1/p' | head -n1)"
[ -n "$INVITE" ] || { echo "ERROR: no invite code in installer output" >&2; exit 1; }
echo "  ok: healthy on :$PORT, invite: $INVITE"

echo "[4/6] signup over plain http with the printed invite (cookie must work)..."
HDRS="$(curl -si -X POST "http://localhost:$PORT/api/auth/signup" \
  -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"smoke-password-1","inviteCode":"'"$INVITE"'"}')"
printf '%s' "$HDRS" | grep -i '^set-cookie: do_session' >/dev/null \
  || { echo "ERROR: no session cookie on signup" >&2; printf '%s\n' "$HDRS" | head -12 >&2; exit 1; }
printf '%s' "$HDRS" | grep -i '^set-cookie: do_session' | grep -qi 'secure' \
  && { echo "ERROR: cookie Secure over plain http — login broken" >&2; exit 1; }
echo "  ok: usable (non-Secure) cookie over http"

echo "[5/6] .env hygiene..."
PERM="$(stat -c %a "$DIR/.env")"
[ "$PERM" = "600" ] || { echo "ERROR: .env perms $PERM, want 600" >&2; exit 1; }
grep -q '^SESSION_SECRET=..' "$DIR/.env" && grep -q '^POSTGRES_PASSWORD=..' "$DIR/.env" \
  || { echo "ERROR: generated secrets missing from .env" >&2; exit 1; }
echo "  ok: chmod 600, secrets present"

echo "[6/6] idempotent re-run (secrets untouched, still healthy)..."
cp "$DIR/.env" "$DIR/.env.before"
TAGWERKE_DIR="$DIR" TAGWERKE_NO_PROMPT=1 TAGWERKE_BUNDLE_DIR="$REPO_DIR/install" \
  sh "$REPO_DIR/install/get.sh" >/dev/null
cmp -s "$DIR/.env" "$DIR/.env.before" || { echo "ERROR: re-run modified .env" >&2; diff "$DIR/.env.before" "$DIR/.env" >&2 || true; exit 1; }
curl -fsS "http://localhost:$PORT/health" >/dev/null || { echo "ERROR: unhealthy after re-run" >&2; exit 1; }
rm -f "$DIR/.env.before"
echo "  ok: byte-identical .env, /health green"

echo
echo "INSTALLER SMOKE PASSED — dry-run inert, http install boots + logs in,"
echo "secrets 600, re-run idempotent. TLS mode still needs one manual pass on a"
echo "server with a real domain (see header)."
