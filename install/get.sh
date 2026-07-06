#!/bin/sh
# ============================================================================
# Tagwerke one-command installer            https://get.tagwerke.com
#
# This exact file lives in the Tagwerke repository at install/get.sh —
# https://github.com/tagwerke/tagwerke — and get.tagwerke.com is a redirect to
# the copy tagged for this release. Read it before running if you like:
#
#   curl -fsSL https://get.tagwerke.com -o install.sh && less install.sh
#   sh install.sh
#
# What it does, in order (nothing else):
#   1. checks it is running as root on Linux
#   2. installs Docker from Docker's official apt repo IF missing (echoed)
#   3. creates /opt/tagwerke and downloads the compose bundle for this release
#   4. generates SESSION_SECRET + POSTGRES_PASSWORD into a chmod-600 .env
#   5. optionally adds Caddy for automatic HTTPS (domain or sslip.io)
#   6. docker compose up -d, waits for /health
#   7. mints your first signup invite code and prints it with the URL
#
# It never sends anything anywhere. The only network calls are: pulling images
# (GHCR/Docker Hub), fetching this release's compose files (GitHub), installing
# Docker (download.docker.com, only if absent), and — only if you enable TLS —
# Caddy talking to Let's Encrypt. No telemetry, no phone-home, ever.
#
# Configuration (env vars; all optional):
#   TAGWERKE_DOMAIN=tw.example.com   serve https://tw.example.com via Caddy
#   TAGWERKE_SSLIP=1                 no domain? real TLS at <ip>.sslip.io
#   TAGWERKE_DIR=/opt/tagwerke       install directory
#   TAGWERKE_PORT=5174               host port in HTTP-only mode
#   TAGWERKE_VERSION=X.Y.Z           image/bundle version (default: this release)
#   TAGWERKE_ORG_NAME="Acme"         workspace name shown in the app
#   TAGWERKE_BACKUP_KEY=1            also generate an age backup key (see docs)
#   TAGWERKE_NO_PROMPT=1             never prompt, even on a terminal
#
# Flags:  --dry-run   print what would be done and written, change nothing
#
# Re-running is safe and is how you reconfigure: existing secrets and data are
# never touched; pass TAGWERKE_DOMAIN=... to move an HTTP install onto HTTPS.
# Docs: https://github.com/tagwerke/tagwerke/blob/main/docs/self-hosting.md
# ============================================================================
set -eu

# ---- release constants (rewritten per release by the tag) ------------------
DEFAULT_VERSION="0.1.0"

# Was TAGWERKE_VERSION explicitly given? (matters on re-runs: an explicit value
# updates a pinned install; an implicit default never downgrades/upgrades one)
VERSION_EXPLICIT="${TAGWERKE_VERSION+yes}"
TAGWERKE_VERSION="${TAGWERKE_VERSION:-$DEFAULT_VERSION}"

TAGWERKE_DIR="${TAGWERKE_DIR:-/opt/tagwerke}"
PORT_EXPLICIT="${TAGWERKE_PORT+yes}"
TAGWERKE_PORT="${TAGWERKE_PORT:-5174}"
TAGWERKE_DOMAIN="${TAGWERKE_DOMAIN:-}"
TAGWERKE_SSLIP="${TAGWERKE_SSLIP:-}"
TAGWERKE_ORG_NAME="${TAGWERKE_ORG_NAME:-}"
TAGWERKE_BACKUP_KEY="${TAGWERKE_BACKUP_KEY:-}"
TAGWERKE_NO_PROMPT="${TAGWERKE_NO_PROMPT:-}"
# Where the compose bundle comes from. Overridable for offline installs and
# tests: point TAGWERKE_BUNDLE_DIR at a local copy of the install/ folder.
TAGWERKE_BUNDLE_DIR="${TAGWERKE_BUNDLE_DIR:-}"
RAW_BASE="${TAGWERKE_RAW_BASE:-https://raw.githubusercontent.com/tagwerke/tagwerke/v${TAGWERKE_VERSION}/install}"

BUNDLE_FILES="compose.app.yml compose.http.yml compose.caddy.yml Caddyfile"

# ---- tiny helpers -----------------------------------------------------------
say()  { printf '%s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
run()  { say "  + $*"; "$@"; }   # execute a command, showing it first

DRY_RUN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) die "unknown argument: $arg (only --dry-run is supported)" ;;
  esac
done

# ---- resolve mode: domain TLS / sslip TLS / plain http ----------------------
# The server's primary IP, best effort (used for the printed URL and sslip).
server_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -n1 ||
    true
}
SERVER_IP="$(server_ip)"
[ -n "$SERVER_IP" ] || SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
[ -n "$SERVER_IP" ] || SERVER_IP="localhost"

is_private_ip() {
  case "$1" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|127.*|localhost) return 0 ;;
    *) return 1 ;;
  esac
}

# Ask for a domain exactly once — only interactively, only when nothing was
# preset. Piped stdin is the script itself, so read from the controlling tty.
if [ -z "$TAGWERKE_DOMAIN" ] && [ "$TAGWERKE_SSLIP" != "1" ] && [ -z "$TAGWERKE_NO_PROMPT" ] \
   && [ -t 1 ] && [ -r /dev/tty ] && [ -z "$DRY_RUN" ]; then
  printf 'Domain for HTTPS (blank = HTTP-only eval on this server): ' > /dev/tty
  IFS= read -r TAGWERKE_DOMAIN < /dev/tty || TAGWERKE_DOMAIN=""
fi

MODE="http" HOST="" APP_URL="http://${SERVER_IP}:${TAGWERKE_PORT}"
if [ -n "$TAGWERKE_DOMAIN" ]; then
  MODE="tls"; HOST="$TAGWERKE_DOMAIN"; APP_URL="https://${HOST}"
elif [ "$TAGWERKE_SSLIP" = "1" ]; then
  is_private_ip "$SERVER_IP" && warn "detected IP ${SERVER_IP} looks private — sslip.io needs a public IP; the certificate request will fail behind NAT."
  MODE="tls"; HOST="$(printf '%s' "$SERVER_IP" | tr . -).sslip.io"; APP_URL="https://${HOST}"
fi
if [ "$MODE" = "tls" ]; then
  COMPOSE_SET="compose.app.yml:compose.caddy.yml"
else
  COMPOSE_SET="compose.app.yml:compose.http.yml"
fi

# ---- dry run: print the plan, touch nothing ---------------------------------
if [ -n "$DRY_RUN" ]; then
  say "tagwerke installer — DRY RUN (nothing will be executed or written)"
  say ""
  say "  version:      ${TAGWERKE_VERSION}"
  say "  install dir:  ${TAGWERKE_DIR}"
  say "  mode:         ${MODE}$( [ "$MODE" = tls ] && printf ' (Caddy, host: %s)' "$HOST" )"
  say "  url:          ${APP_URL}"
  say "  bundle from:  ${TAGWERKE_BUNDLE_DIR:-$RAW_BASE}"
  say "  compose set:  ${COMPOSE_SET}"
  say ""
  say "  would: install Docker if missing (Docker's official apt repo, echoed)"
  say "  would: download bundle files: ${BUNDLE_FILES}"
  say "  would: write ${TAGWERKE_DIR}/.env (chmod 600) roughly as:"
  say "     TAGWERKE_VERSION=${TAGWERKE_VERSION}"
  say "     COMPOSE_FILE=${COMPOSE_SET}"
  say "     SESSION_SECRET=<generated 96-char secret>"
  say "     POSTGRES_PASSWORD=<generated 48-char secret>"
  say "     APP_URL=${APP_URL}"
  [ "$MODE" = "tls" ] && say "     TAGWERKE_HOST=${HOST}"
  [ "$MODE" = "http" ] && say "     APP_PORT=${TAGWERKE_PORT}"
  say "  would: docker compose pull && up -d; wait for /health; mint invite"
  exit 0
fi

# ---- preflight ---------------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || die "this installer targets Linux servers. On other systems, follow the manual guide: docs/self-hosting.md"
[ "$(id -u)" = "0" ] || die "must run as root. Re-run as:  curl -fsSL https://get.tagwerke.com | sudo sh"
have curl || die "curl is required (apt-get install -y curl) — it fetched this script, so this should not happen"

# ---- docker ------------------------------------------------------------------
step 1/7 "Docker"
if have docker && docker compose version >/dev/null 2>&1; then
  say "  ok: docker + compose plugin already installed"
else
  have apt-get || die "Docker is missing and this system has no apt-get. Install Docker + the compose plugin yourself (https://docs.docker.com/engine/install/), then re-run."
  . /etc/os-release 2>/dev/null || die "cannot read /etc/os-release to pick the Docker repo"
  case "${ID:-}" in ubuntu|debian) : ;; *) die "Docker auto-install supports Ubuntu/Debian (found: ${ID:-unknown}). Install Docker yourself, then re-run." ;; esac
  say "  installing Docker from download.docker.com (official ${ID} repo):"
  run apt-get update -q
  run apt-get install -y -q ca-certificates curl
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  say "  + writing /etc/apt/sources.list.d/docker.list"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$ID" "${VERSION_CODENAME:-stable}" > /etc/apt/sources.list.d/docker.list
  run apt-get update -q
  run apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Docker installed but 'docker compose' still unavailable — check the output above"
  say "  ok: docker installed"
fi

# ---- install dir + compose bundle --------------------------------------------
step 2/7 "Install directory: ${TAGWERKE_DIR}"
mkdir -p "$TAGWERKE_DIR" "$TAGWERKE_DIR/backups"
cd "$TAGWERKE_DIR"

step 3/7 "Compose bundle for v${TAGWERKE_VERSION}"
for f in $BUNDLE_FILES; do
  if [ -n "$TAGWERKE_BUNDLE_DIR" ]; then
    cp "$TAGWERKE_BUNDLE_DIR/$f" "./$f"
  else
    curl -fsSL "$RAW_BASE/$f" -o "./$f" || die "could not fetch $RAW_BASE/$f — does tag v${TAGWERKE_VERSION} exist?"
  fi
done
say "  ok: ${BUNDLE_FILES}"

# ---- .env: create once, then only update what the user explicitly changed ----
# set_env KEY VALUE — replace the KEY= line or append it.
set_env() {
  if grep -q "^$1=" .env 2>/dev/null; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
gen_secret() { # gen_secret <bytes> — hex, so it is always URL/compose-safe
  if have openssl; then openssl rand -hex "$1"; else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

step 4/7 "Secrets + configuration (.env)"
if [ ! -f .env ]; then
  umask 077
  SESSION_SECRET="$(gen_secret 48)"
  POSTGRES_PASSWORD="$(gen_secret 24)"
  cat > .env <<EOF
# Tagwerke configuration — generated by the installer $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Safe to edit; re-running the installer never overwrites your values.
# All options: https://github.com/tagwerke/tagwerke/blob/main/.env.example

# Release to run. To upgrade: change this, then
#   docker compose pull && docker compose up -d
TAGWERKE_VERSION=${TAGWERKE_VERSION}

# Which compose files make up this deployment (managed by the installer).
COMPOSE_FILE=${COMPOSE_SET}

# Secrets (generated; header comment in each file explains their use).
SESSION_SECRET=${SESSION_SECRET}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# Public URL — used in password-reset links and passkey binding.
APP_URL=${APP_URL}
EOF
  [ "$MODE" = "tls" ]  && printf 'TAGWERKE_HOST=%s\n' "$HOST" >> .env
  [ "$MODE" = "http" ] && printf 'APP_PORT=%s\n' "$TAGWERKE_PORT" >> .env
  [ -n "$TAGWERKE_ORG_NAME" ] && printf 'ORG_NAME=%s\n' "$TAGWERKE_ORG_NAME" >> .env
  cat >> .env <<'EOF'

# Email is OPTIONAL (password reset only — login needs no email). To enable,
# set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_FROM here (see .env.example).

# Backups run automatically every day into ./backups (never uploaded anywhere).
# Recommended: encrypt them — see "Backup & restore" in docs/self-hosting.md.
# BACKUP_AGE_RECIPIENT=age1...
EOF
  chmod 600 .env
  say "  ok: generated .env (chmod 600) with fresh SESSION_SECRET + POSTGRES_PASSWORD"
else
  say "  ok: existing .env found — secrets and data untouched"
  # Only what was EXPLICITLY passed this run may change an existing install:
  [ -n "$VERSION_EXPLICIT" ] && { set_env TAGWERKE_VERSION "$TAGWERKE_VERSION"; say "  updated: TAGWERKE_VERSION=${TAGWERKE_VERSION}"; }
  if [ -n "$TAGWERKE_DOMAIN" ] || [ "$TAGWERKE_SSLIP" = "1" ]; then
    set_env COMPOSE_FILE "$COMPOSE_SET"
    set_env APP_URL "$APP_URL"
    set_env TAGWERKE_HOST "$HOST"
    say "  updated: switched to HTTPS mode (${HOST})"
  elif [ -n "$PORT_EXPLICIT" ]; then
    set_env APP_PORT "$TAGWERKE_PORT"
  fi
fi

# From here on, .env is the single source of truth for where the app lives —
# a re-run must poll and print the EXISTING deployment, not this run's defaults.
env_get() { sed -n "s/^$1=//p" .env | head -n1; }
APP_URL="$(env_get APP_URL)"
case "$APP_URL" in
  https://*) MODE="tls"; HOST="$(env_get TAGWERKE_HOST)" ;;
  *)         MODE="http"; TAGWERKE_PORT="$(env_get APP_PORT)"; [ -n "$TAGWERKE_PORT" ] || TAGWERKE_PORT=5174 ;;
esac

# ---- optional: age backup key (opt-in) ----------------------------------------
if [ "$TAGWERKE_BACKUP_KEY" = "1" ] && ! grep -q '^BACKUP_AGE_RECIPIENT=age1' .env 2>/dev/null; then
  step 5/7 "Backup encryption key (age)"
  # age ships inside the app image — generate the key there, keep it here.
  docker compose pull -q app >/dev/null 2>&1 || true
  docker compose run --rm --no-deps app age-keygen > tagwerke-backup-key.txt 2>/dev/null \
    || die "could not run age-keygen in the app image"
  chmod 600 tagwerke-backup-key.txt
  PUBKEY="$(sed -n 's/^# public key: //p' tagwerke-backup-key.txt | head -n1)"
  [ -n "$PUBKEY" ] || die "age-keygen produced no public key"
  set_env BACKUP_AGE_RECIPIENT "$PUBKEY"
  say "  ok: backups will be encrypted to ${PUBKEY}"
  warn "the SECRET key is ${TAGWERKE_DIR}/tagwerke-backup-key.txt — move it OFF this server (password manager / offline). Without it, encrypted backups cannot be restored; with it, anyone can read them."
else
  step 5/7 "Backup encryption key — skipped (opt in with TAGWERKE_BACKUP_KEY=1; see docs/self-hosting.md)"
fi

# ---- start --------------------------------------------------------------------
step 6/7 "Starting Tagwerke (docker compose up -d)"
docker compose pull -q || warn "image pull failed — continuing with locally available images"
docker compose up -d

# Health: through Caddy in TLS mode (also waits out certificate issuance).
if [ "$MODE" = "tls" ]; then HEALTH_URL="https://${HOST}/health"; TRIES=60; else HEALTH_URL="http://localhost:${TAGWERKE_PORT}/health"; TRIES=40; fi
say "  waiting for ${HEALTH_URL} ..."
i=0
until curl -fsS "$HEALTH_URL" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge "$TRIES" ]; then
    say "---- last app logs ----"; docker compose logs app 2>/dev/null | tail -30 || true
    [ "$MODE" = "tls" ] && warn "for HTTPS: DNS for ${HOST} must point at this server and ports 80+443 must be reachable from the internet (Let's Encrypt validates over them)."
    die "app did not become healthy at ${HEALTH_URL}"
  fi
  sleep 3
done
say "  ok: /health is green"

# ---- first invite --------------------------------------------------------------
step 7/7 "First signup invite"
INVITE="$(docker compose exec -T app npm run --silent invite 2>/dev/null | sed -n 's/.*invite code:[[:space:]]*//p' | head -n1 | tr -d '[:space:]')"
[ -n "$INVITE" ] || die "could not mint an invite — try manually: cd ${TAGWERKE_DIR} && docker compose exec app npm run invite"

# ---- summary --------------------------------------------------------------------
say ""
say "=================================================================="
say "  Tagwerke is running."
say ""
say "  Open:         ${APP_URL}"
say "  Invite code:  ${INVITE}     (sign up with it — first user in)"
say ""
if [ "$MODE" = "http" ]; then
  say "  ! HTTP mode: fine for evaluation; traffic (incl. the session cookie)"
  say "    is unencrypted. For production, point a domain at this server and:"
  say "      TAGWERKE_DOMAIN=tw.example.com  curl -fsSL https://get.tagwerke.com | sudo sh"
fi
say "  - Email is not configured: password reset stays off until you set"
say "    SMTP_* in ${TAGWERKE_DIR}/.env (login/invites need no email)."
say "  - Backups: automatic daily dumps in ${TAGWERKE_DIR}/backups —"
say "    encrypt them and copy them off this server (docs/self-hosting.md)."
say ""
say "  Manage:   cd ${TAGWERKE_DIR} && docker compose ps|logs|down"
say "  Upgrade:  edit TAGWERKE_VERSION in .env, then docker compose pull && docker compose up -d"
say "  Docs:     https://github.com/tagwerke/tagwerke/blob/main/docs/self-hosting.md"
say "=================================================================="
