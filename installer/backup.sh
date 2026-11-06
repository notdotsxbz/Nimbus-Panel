#!/usr/bin/env bash
# NIMBUS backup — database archive + environment snapshot.
# (Per-service backups run through the node agents; this covers the control plane.)
set -euo pipefail
BACKUP_DIR="${1:-/var/backups/nimbus}"
STAMP=$(date +%Y%m%d-%H%M%S)
log() { printf '\033[1;37m[nimbus-backup]\033[0m %s\n' "$*"; }

mkdir -p "${BACKUP_DIR}"
log "Dumping MongoDB…"
mongodump --quiet --db nimbus --archive="${BACKUP_DIR}/nimbus-db-${STAMP}.archive"
[ -f /opt/nimbus/.env ] && cp /opt/nimbus/.env "${BACKUP_DIR}/env-${STAMP}.bak"
sha256sum "${BACKUP_DIR}/nimbus-db-${STAMP}.archive" > "${BACKUP_DIR}/nimbus-db-${STAMP}.archive.sha256"

log "Backup complete:"
ls -lh "${BACKUP_DIR}" | tail -3
log "Verify integrity with: sha256sum -c ${BACKUP_DIR}/nimbus-db-${STAMP}.archive.sha256"
