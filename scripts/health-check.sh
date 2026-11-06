#!/usr/bin/env bash
# Quick control-plane health check
set -uo pipefail
ok()   { printf '\033[1;32m OK \033[0m %s\n' "$1"; }
bad()  { printf '\033[1;31mFAIL\033[0m %s\n' "$1"; }

curl -fs -o /dev/null http://127.0.0.1:4000/api/v1/auth/me 2>/dev/null \
  && ok "API responding on :4000" || bad "API not responding on :4000"
systemctl is-active --quiet nimbus-web && ok "Web service running" || bad "Web service down"
systemctl is-active --quiet mongod && ok "MongoDB running" || bad "MongoDB down"
systemctl is-active --quiet redis-server && ok "Redis running" || bad "Redis down"
