#!/usr/bin/env bash
# NIMBUS control-plane backup. Run as root; the resulting archive contains secrets.
set -euo pipefail
umask 077
BACKUP_DIR="${1:-/var/backups/nimbus}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p -- "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd -P)"
WORK="$(mktemp -d "$BACKUP_DIR/.nimbus-backup.XXXXXXXX")"
cleanup() { rm -rf -- "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/control-plane" "$WORK/config"
command -v mongodump >/dev/null || { echo "mongodump is required" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }
echo "Backing up NIMBUS MongoDB..."
# Preserve all NIMBUS collections, including service-to-owner and node mappings.
mongodump --quiet --db nimbus --archive="$WORK/control-plane/mongodb.archive"
for file in /opt/nimbus/.env /etc/systemd/system/nimbus-api.service /etc/systemd/system/nimbus-web.service; do
  if [[ -f "$file" ]]; then
    cp -- "$file" "$WORK/config/$(basename "$file")"
  fi
done
# Service volumes live on agents, not on this control-plane VPS.
cat > "$WORK/README.txt" <<'EOF'
NIMBUS CONTROL-PLANE BACKUP
Contains MongoDB (including customer/service/node mappings) and control-plane config.
Does NOT contain service files, container volumes, or external node data.
Restore only to a stopped, isolated recovery environment after verification.
Contains secrets. Restrict access and encrypt before offsite transfer.
EOF
(
  cd "$WORK"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)
OUT="$BACKUP_DIR/nimbus-control-plane-$STAMP.tar.gz"
tar -C "$WORK" -czf "$OUT.tmp" .
mv -- "$OUT.tmp" "$OUT"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
echo "Backup saved: $OUT"
echo "Verify: cd '$BACKUP_DIR' && sha256sum -c '$(basename "$OUT").sha256'"
