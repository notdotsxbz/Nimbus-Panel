#!/usr/bin/env bash
# Rotate panel + nginx logs weekly (add to /etc/cron.weekly)
set -euo pipefail
for f in /var/log/nimbus/*.log; do
  [ -f "$f" ] || continue
  mv "$f" "${f}.$(date +%Y%m%d)"
  gzip "${f}.$(date +%Y%m%d)"
done
find /var/log/nimbus -name '*.gz' -mtime +30 -delete
[ -d /var/log/nginx ] && find /var/log/nginx -name '*.gz' -mtime +30 -delete
systemctl reload nginx 2>/dev/null || true
