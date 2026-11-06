#!/usr/bin/env bash
# NIMBUS uninstall — stops services and REMOVES CODE ONLY by default.
# Customer data (MongoDB, /var/lib/nimbus) is preserved unless --purge-data
# is given, and even then requires typing DESTROY.
set -euo pipefail
log() { printf '\033[1;37m[nimbus-uninstall]\033[0m %s\n' "$*"; }

systemctl disable --now nimbus-api nimbus-web 2>/dev/null || true
rm -f /etc/systemd/system/nimbus-{api,web}.service
systemctl daemon-reload
rm -f /etc/nginx/sites-enabled/nimbus /etc/nginx/sites-available/nimbus
systemctl reload nginx 2>/dev/null || true
rm -rf /opt/nimbus
log "Application removed. MongoDB data and /var/lib/nimbus (node data) are PRESERVED."

if [ "${1:-}" = "--purge-data" ]; then
  echo "This permanently deletes ALL customer data (MongoDB nimbus database, /var/lib/nimbus)."
  read -rp "Type DESTROY to continue: " ANSWER
  if [ "${ANSWER}" = "DESTROY" ]; then
    mongosh --quiet --eval 'db.getSiblingDB("nimbus").dropDatabase()' || true
    rm -rf /var/lib/nimbus
    log "All NIMBUS data destroyed."
  else
    log "Purge cancelled — data preserved."
  fi
fi
