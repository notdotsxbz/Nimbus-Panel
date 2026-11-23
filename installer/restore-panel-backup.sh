#!/usr/bin/env bash
# NIMBUS full panel database/configuration restore.
# Service data archives remain in Admin Google Drive and are restored separately
# from the Admin Backups page after the panel services restart.
set -Eeuo pipefail
umask 077

INSTALL_DIR="${NIMBUS_INSTALL_DIR:-/opt/nimbus}"
BACKUP_ID="${1:-}"
RESTORE_DIR="${INSTALL_DIR}/var/restore-staging/${BACKUP_ID}"
ENV_FILE="${INSTALL_DIR}/.env"
STAMP="$(date +%Y%m%d-%H%M%S)"
SAFETY_DIR="/var/backups/nimbus/restore-safety-${STAMP}"
RESTORE_STARTED=0
RESTORE_COMPLETE=0

log() { printf '[nimbus-restore] %s\n' "$*"; }
fail() { printf '[nimbus-restore] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$EUID" -eq 0 ]] || fail "Run this script with sudo."
[[ "$BACKUP_ID" =~ ^[a-f0-9]{24}$ ]] || fail "Usage: sudo bash installer/restore-panel-backup.sh <backup-id>"
[[ -d "$RESTORE_DIR" ]] || fail "Restore package not found: $RESTORE_DIR"
[[ -f "$RESTORE_DIR/database.archive.gz" ]] || fail "Database archive is missing."
[[ -f "$RESTORE_DIR/environment.env" ]] || fail "Environment snapshot is missing."
[[ -f "$RESTORE_DIR/manifest.json" ]] || fail "Backup manifest is missing."
[[ -f "$ENV_FILE" ]] || fail "Current .env file is missing."

command -v mongodump >/dev/null 2>&1 || fail "mongodump is not installed."
command -v mongorestore >/dev/null 2>&1 || fail "mongorestore is not installed."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is not installed."

(
  cd "$RESTORE_DIR"
  sha256sum -c database.archive.gz.sha256
  sha256sum -c environment.env.sha256
  sha256sum -c system-metadata.json.sha256
)

printf '\nWARNING: This replaces the NIMBUS panel database and .env configuration.\n'
printf 'Customer service files are not replaced by this script.\n'
read -r -p 'Type RESTORE FULL NIMBUS PANEL to continue: ' CONFIRM
[[ "$CONFIRM" == "RESTORE FULL NIMBUS PANEL" ]] || fail "Confirmation did not match. Nothing was changed."

mkdir -p "$SAFETY_DIR"
chmod 700 "$SAFETY_DIR"
cp -a "$ENV_FILE" "$SAFETY_DIR/env-before-restore.bak"
chmod 600 "$SAFETY_DIR/env-before-restore.bak"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
[[ -n "${MONGODB_URI:-}" ]] || fail "MONGODB_URI is missing from the current .env."

write_mongo_config() {
  local uri="$1"
  local output="$2"
  local escaped="$uri"
  escaped="${escaped//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  printf 'uri: "%s"\n' "$escaped" > "$output"
  chmod 600 "$output"
}

OLD_MONGO_CONFIG="$SAFETY_DIR/mongo-before.yml"
write_mongo_config "$MONGODB_URI" "$OLD_MONGO_CONFIG"

log "Creating a safety dump of the current panel database…"
mongodump --quiet --config "$OLD_MONGO_CONFIG" --archive="$SAFETY_DIR/database-before.archive.gz" --gzip
[[ -s "$SAFETY_DIR/database-before.archive.gz" ]] || fail "Could not create the safety database dump."

rollback() {
  local exit_code=$?
  if [[ "$RESTORE_STARTED" -eq 1 && "$RESTORE_COMPLETE" -eq 0 ]]; then
    log "Restore failed. Attempting to roll back the database and .env…"
    cp -a "$SAFETY_DIR/env-before-restore.bak" "$ENV_FILE"
    chown nimbus:nimbus "$ENV_FILE" || true
    chmod 600 "$ENV_FILE" || true
    mongorestore --quiet --config "$OLD_MONGO_CONFIG" --archive="$SAFETY_DIR/database-before.archive.gz" --gzip --drop || log "WARNING: database rollback failed; administrator intervention is required."
    systemctl start nimbus-api || true
    systemctl start nimbus-web || true
    log "Safety files are in $SAFETY_DIR"
  fi
  exit "$exit_code"
}
trap rollback ERR

log "Stopping NIMBUS web and API services…"
systemctl stop nimbus-web nimbus-api
RESTORE_STARTED=1

log "Installing the backed-up environment file…"
install -o nimbus -g nimbus -m 600 "$RESTORE_DIR/environment.env" "$ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
[[ -n "${MONGODB_URI:-}" ]] || fail "Restored .env does not contain MONGODB_URI."

NEW_MONGO_CONFIG="$SAFETY_DIR/mongo-restored.yml"
write_mongo_config "$MONGODB_URI" "$NEW_MONGO_CONFIG"

log "Restoring the panel database…"
mongorestore --quiet --config "$NEW_MONGO_CONFIG" --archive="$RESTORE_DIR/database.archive.gz" --gzip --drop

log "Starting NIMBUS API and web services…"
systemctl start nimbus-api
systemctl start nimbus-web
sleep 5
systemctl is-active --quiet nimbus-api || fail "NIMBUS API did not become active."
systemctl is-active --quiet nimbus-web || fail "NIMBUS web did not become active."

RESTORE_COMPLETE=1
trap - ERR
log "Panel database and configuration restore completed."
log "Safety backup: $SAFETY_DIR"
rm -rf -- "$RESTORE_DIR"
log "Removed decrypted staging files after successful restore."
log "Next: open the Admin Backups page and restore the service backups listed in the restored backup manifest."
