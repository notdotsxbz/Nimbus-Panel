#!/usr/bin/env bash
# NIMBUS upgrade — backs up data and configuration, then updates the code.
set -euo pipefail
INSTALL_DIR="/opt/nimbus"
BACKUP_DIR="/var/backups/nimbus"
STAMP=$(date +%Y%m%d-%H%M%S)
log() { printf '\033[1;37m[nimbus-upgrade]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[nimbus-upgrade] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
[ -d "${INSTALL_DIR}" ] || die "NIMBUS is not installed at ${INSTALL_DIR}."

log "Backing up database and configuration…"
mkdir -p "${BACKUP_DIR}"
mongodump --quiet --db nimbus --archive="${BACKUP_DIR}/nimbus-db-${STAMP}.archive" 2>/dev/null \
  || die "mongodump failed — upgrade aborted, customer data untouched."
cp "${INSTALL_DIR}/.env" "${BACKUP_DIR}/env-${STAMP}.bak"

# PANEL_DOMAIN from .env — needed to bake NEXT_PUBLIC_API_URL into the build
PANEL_DOMAIN=""
if [ -f "${INSTALL_DIR}/.env" ]; then
  PANEL_DOMAIN=$(grep -E '^PANEL_DOMAIN=' "${INSTALL_DIR}/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

log "Upgrading application code…"
cd "${INSTALL_DIR}"
git fetch --depth 1 origin main
git reset --hard origin/main
npm install --no-audit --no-fund >/dev/null
npm run build --workspace @nimbus/api >/dev/null
NEXT_PUBLIC_API_URL="https://${PANEL_DOMAIN:-}" npm run build --workspace @nimbus/web >/dev/null

# Standalone output needs static assets + public copied next to server.js
WEB_DIR="${INSTALL_DIR}/apps/web"
STANDALONE="${WEB_DIR}/.next/standalone/apps/web"
mkdir -p "${STANDALONE}/.next/static" "${STANDALONE}/public"
cp -a "${WEB_DIR}/.next/static/." "${STANDALONE}/.next/static/"
cp -a "${WEB_DIR}/public/." "${STANDALONE}/public/"
chown -R nimbus:nimbus "${WEB_DIR}/.next" 2>/dev/null || true
chown -R nimbus:nimbus "${INSTALL_DIR}" 2>/dev/null || true

log "Restarting services…"
systemctl restart nimbus-api nimbus-web

sleep 4
systemctl is-active --quiet nimbus-api && log "API: running" || die "API failed to start — restore from ${BACKUP_DIR} (see recovery.sh)."
systemctl is-active --quiet nimbus-web && log "Web: running" || log "WARN: web service not active yet."
log "Upgrade complete. Previous backup: ${BACKUP_DIR}/nimbus-db-${STAMP}.archive"
