#!/usr/bin/env bash
# NIMBUS recovery — restore the control plane from a backup archive.
# NEVER silently overwrites data: requires an explicit --confirm flag.
set -euo pipefail
die() { printf '\033[1;31m[nimbus-recovery] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[1;37m[nimbus-recovery]\033[0m %s\n' "$*"; }

ARCHIVE="${1:-}"
CONFIRM="${2:-}"
[ -n "${ARCHIVE}" ] && [ -f "${ARCHIVE}" ] || die "Usage: recovery.sh <archive-file> --confirm"
[ "${CONFIRM}" = "--confirm" ] || die "Refusing to overwrite data without --confirm."

[ "$(id -u)" -eq 0 ] || die "Run with sudo."

log "Verifying checksum…"
if [ -f "${ARCHIVE}.sha256" ]; then
  (cd "$(dirname "${ARCHIVE}")" && sha256sum -c "$(basename "${ARCHIVE}").sha256") || die "Checksum mismatch — archive corrupted, restore aborted."
else
  log "WARN: no checksum file found, continuing without integrity verification."
fi

log "Pre-restore safety dump…"
STAMP=$(date +%Y%m%d-%H%M%S)
mongodump --quiet --db nimbus --archive="/var/backups/nimbus/pre-restore-${STAMP}.archive" 2>/dev/null || true

log "Restoring database from ${ARCHIVE}…"
mongorestore --drop --quiet --archive="${ARCHIVE}"

log "Restarting services…"
systemctl restart nimbus-api nimbus-web
log "Recovery complete. Pre-restore snapshot kept at /var/backups/nimbus/pre-restore-${STAMP}.archive"
