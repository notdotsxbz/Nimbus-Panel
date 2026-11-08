#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS — Diagnostics & Safe Repair (Command 3 of 3)
#
#  curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/doctor.sh | sudo bash
#
#  Checks every NIMBUS component, prints a diagnostic report, and performs
#  ONLY safe, reversible repairs (service restarts, log hints). Anything
#  destructive requires explicit confirmation and is never automatic.
#  Works on an existing /opt/nimbus installation; safe to run anytime.
# ═══════════════════════════════════════════════════════════════════
set -uo pipefail
# NOTE: deliberately NOT -e — doctor must complete ALL checks even when
# individual ones fail; failures are collected into the report instead.

INSTALL_DIR="/opt/nimbus"
ENV_FILE="${INSTALL_DIR}/.env"
REPORT="/tmp/nimbus-doctor-report.txt"
PASS=0; WARN=0; FAIL=0; REPAIRED=0
declare -a ACTIONS=()

ok()   { PASS=$((PASS+1)); printf '  \033[1;32mPASS\033[0m  %s\n' "$1" | tee -a "$REPORT"; }
warn() { WARN=$((WARN+1)); printf '  \033[1;33mWARN\033[0m  %s\n' "$1" | tee -a "$REPORT"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[1;31mFAIL\033[0m  %s\n' "$1" | tee -a "$REPORT"; }
info() { printf '  \033[1;37mi\033[0m     %s\n' "$1" | tee -a "$REPORT"; }

svc_active() { systemctl is-active --quiet "$1" 2>/dev/null; }

# Read a value from the .env without exposing secrets.
env_get() {
  [ -f "$ENV_FILE" ] || return 1
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

API_PORT="$(env_get API_PORT || echo 4000)"
API_URL="http://127.0.0.1:${API_PORT}"

echo "──────────────────────────────────────────────────" | tee "$REPORT"
echo " NIMBUS Doctor — $(date '+%Y-%m-%d %H:%M:%S')"      | tee -a "$REPORT"
echo "──────────────────────────────────────────────────" | tee -a "$REPORT"

# ── 1. Installation & environment ─────────────────────────────────
echo "◆ Installation"
if [ -d "${INSTALL_DIR}/.git" ]; then ok "Installation directory (${INSTALL_DIR})"; else bad "Installation directory missing — run install.sh"; fi
if [ -f "$ENV_FILE" ]; then
  ok "Environment file (.env)"
  for key in JWT_SECRET AGENT_SHARED_SECRET MONGODB_URI NEXT_PUBLIC_API_URL; do
    if [ -n "$(env_get "$key")" ]; then ok "Environment: ${key} set"; else warn "Environment: ${key} missing — web builds may call the wrong API URL"; fi
  done
else
  bad "Environment file (.env) missing"
fi
if [ -f "${ENV_FILE}.backup" ] || ls /var/backups/nimbus/*.archive >/dev/null 2>&1; then
  info "Backups found (see /var/backups/nimbus)"
else
  warn "No backups detected — run installer/backup.sh"
fi

# ── 2. System services ────────────────────────────────────────────
echo "◆ System services"
for svc in nimbus-api nimbus-web mongod redis-server; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}.service"; then
    if svc_active "$svc"; then ok "service ${svc}: active"
    else
      bad "service ${svc}: NOT active"
      if [ "${1:-}" = "--repair" ]; then
        systemctl restart "$svc" 2>/dev/null && sleep 2
        if svc_active "$svc"; then REPAIRED=$((REPAIRED+1)); ACTIONS+=("restarted ${svc}"); printf '  \033[1;36mFIX\033[0m   restarted %s\n' "$svc" | tee -a "$REPORT"; else bad "restart of ${svc} failed — check journalctl -u ${svc}"; fi
      else
        ACTIONS+=("run with --repair to restart dead services")
      fi
    fi
  else
    if [ "$svc" = "redis-server" ]; then warn "service ${svc} not installed (optional)"; else bad "service ${svc} unit does not exist"; fi
  fi
done
systemctl is-enabled --quiet nimbus-api 2>/dev/null && ok "nimbus-api enabled at boot" || warn "nimbus-api not enabled at boot (systemctl enable nimbus-api)"

# ── 3. API & web reachability ─────────────────────────────────────
echo "◆ API and frontend"
HTTP_CODE=$(curl -fs -o /dev/null -w '%{http_code}' --max-time 5 "${API_URL}/api/v1/auth/me" 2>/dev/null || echo 000)
if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "200" ]; then
  ok "API responding on :${API_PORT} (unauthenticated 401 is expected)"
else
  bad "API not responding on :${API_PORT} (HTTP ${HTTP_CODE})"
fi
WEB_CODE=$(curl -fs -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/ 2>/dev/null || echo 000)
if [ "$WEB_CODE" = "200" ]; then ok "Web responding on :3000"; else bad "Web not responding on :3000 (HTTP ${WEB_CODE})"; fi
if [ -s "${INSTALL_DIR}/apps/web/.next/standalone/apps/web/server.js" ]; then
  ok "Next.js standalone server present"
  [ -d "${INSTALL_DIR}/apps/web/.next/standalone/apps/web/.next/static" ] && ok "Standalone static assets copied" || warn "Standalone static assets missing — CSS/JS will 404. Re-run install.sh or upgrade.sh"
else
  bad "Next.js standalone server.js missing — web build incomplete"
fi

# ── 4. MongoDB ────────────────────────────────────────────────────
echo "◆ MongoDB"
if command -v mongosh >/dev/null 2>&1; then
  MONGO_URI="$(env_get MONGODB_URI || echo 'mongodb://localhost:27017/nimbus')"
  PING=$(mongosh --quiet --eval "db.runCommand({ ping: 1 }).ok" "${MONGO_URI}" 2>/dev/null || echo 0)
  if [ "$PING" = "1" ]; then
    ok "MongoDB accepts connections (URI from .env)"
    COLS=$(mongosh --quiet --eval "db.getCollectionNames().length" "${MONGO_URI}" 2>/dev/null || echo 0)
    [ "${COLS}" -ge 1 ] 2>/dev/null && ok "Application database initialized (${COLS} collections)" || warn "Application database has no collections yet"
    # Migrations applied?
    MIG=$(mongosh --quiet --eval "db.migrations.countDocuments({})" "${MONGO_URI}" 2>/dev/null || echo "?")
    info "Recorded migrations: ${MIG}"
  else
    bad "MongoDB unreachable with the URI from .env — check mongod service and credentials"
  fi
  if ss -ltn 2>/dev/null | grep -qE '27017.*0\.0\.0\.0|\[::\]'; then
    warn "MongoDB listens on ALL interfaces — should bind 127.0.0.1 (check /etc/mongod.conf net.bindIp)"
  else
    ok "MongoDB not exposed publicly"
  fi
else
  bad "mongosh not found — MongoDB tooling missing"
fi

# ── 5. Node agent connectivity (Control Plane side) ───────────────
echo "◆ Node agents"
if command -v mongosh >/dev/null 2>&1 && [ "$PING" = "1" ]; then
  OFFLINE=$(mongosh --quiet --eval 'db.nodes.countDocuments({ status: { $ne: "retired" }, online: false })' "${MONGO_URI}" 2>/dev/null || echo "?")
  ONLINE=$(mongosh --quiet --eval 'db.nodes.countDocuments({ online: true })' "${MONGO_URI}" 2>/dev/null || echo "?")
  info "Nodes online: ${ONLINE} · offline: ${OFFLINE}"
  [ "${OFFLINE}" -gt 0 ] 2>/dev/null && warn "Some nodes are offline — check the agent on those machines (systemctl status nimbus-agent)"
fi

# ── 6. Reverse proxy & SSL ────────────────────────────────────────
echo "◆ Reverse proxy & SSL"
if command -v nginx >/dev/null 2>&1; then
  nginx -t >/dev/null 2>&1 && ok "nginx configuration valid" || bad "nginx configuration INVALID — run: nginx -t"
  svc_active nginx && ok "nginx active" || warn "nginx not active"
  PANEL_DOMAIN="$(env_get PANEL_DOMAIN || echo '')"
  if [ -n "$PANEL_DOMAIN" ] && [ "$PANEL_DOMAIN" != "panel.example.com" ]; then
    if [ -f "/etc/letsencrypt/live/${PANEL_DOMAIN}/fullchain.pem" ]; then
      ok "TLS certificate present for ${PANEL_DOMAIN}"
      EXPIRY=$(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/${PANEL_DOMAIN}/fullchain.pem" 2>/dev/null | cut -d= -f2)
      info "Certificate expires: ${EXPIRY:-unknown}"
    else
      warn "No Let's Encrypt certificate for ${PANEL_DOMAIN} — run: certbot --nginx -d ${PANEL_DOMAIN}"
    fi
  fi
else
  warn "nginx not installed"
fi

# ── 7. Resource & security checks ─────────────────────────────────
echo "◆ Resources & security"
DISK_PCT=$(df -P / | awk 'NR==2 {gsub("%",""); print $5}')
[ "${DISK_PCT:-100}" -lt 85 ] 2>/dev/null && ok "Disk usage ${DISK_PCT}%" || warn "Disk usage ${DISK_PCT}% — clean up or expand storage"
if ss -ltn 2>/dev/null | grep -qE ':(2375|2376)\b'; then
  bad "Docker TCP API exposed — critical security issue, remove it"
else
  ok "Docker API not exposed on TCP"
fi
if [ -f "$ENV_FILE" ]; then
  PERMS=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 000)
  [ "$PERMS" = "600" ] && ok ".env permissions 600" || warn ".env permissions are ${PERMS} — run: chmod 600 ${ENV_FILE}"
fi

# ── Summary ───────────────────────────────────────────────────────
echo "──────────────────────────────────────────────────" | tee -a "$REPORT"
printf ' Result: \033[1;32m%d PASS\033[0m · \033[1;33m%d WARN\033[0m · \033[1;31m%d FAIL\033[0m · %d repaired\n' "$PASS" "$WARN" "$FAIL" "$REPAIRED" | tee -a "$REPORT"
if [ "${#ACTIONS[@]}" -gt 0 ]; then
  echo " Suggested actions:" | tee -a "$REPORT"
  for a in "${ACTIONS[@]}"; do echo "  - $a" | tee -a "$REPORT"; done
fi
echo " Full report saved to: ${REPORT}" | tee -a "$REPORT"
echo "──────────────────────────────────────────────────" | tee -a "$REPORT"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
