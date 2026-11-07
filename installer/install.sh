#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS Hosting Panel — One-Command Installer (Ubuntu 20.04+ / Debian 11+)
#
#  curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh | sudo bash
#
#  Never destroys customer data without explicit confirmation.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="notdotsxbz/Nimbus-Panel"
BRANCH="main"
INSTALL_DIR="/opt/nimbus"
SERVICE_USER="nimbus"

log()  { printf '\033[1;37m[nimbus]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[nimbus]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[nimbus] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo (the installer configures system services)."

# ── 1. System checks ─────────────────────────────────────────────
if [ -r /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) log "Detected ${PRETTY_NAME:-unknown}" ;;
    *) warn "Unsupported OS '${ID:-unknown}' — continuing, but Ubuntu/Debian are the only tested platforms." ;;
  esac
fi

TOTAL_RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
CPU_CORES=$(nproc)
DISK_GB=$(df -BG / | awk 'NR==2 {print int($4)}')
log "System: ${CPU_CORES} cores · ${TOTAL_RAM_MB} MB RAM · ${DISK_GB} GB free disk"

if [ "${TOTAL_RAM_MB}" -lt 3500 ]; then
  warn "Less than 4 GB RAM detected — the control plane may be tight. 8 GB is recommended with workers."
fi
[ "${DISK_GB}" -ge 10 ] || die "At least 10 GB free disk is required."

# ── 2. Installation wizard ───────────────────────────────────────
echo
log "────────── NIMBUS Installation Wizard ──────────"
read -rp "Panel domain or IP [panel.example.com]: " PANEL_DOMAIN
PANEL_DOMAIN=${PANEL_DOMAIN:-panel.example.com}
read -rp "Hosting domain for free subdomains [nimbushost.com]: " HOSTING_DOMAIN
HOSTING_DOMAIN=${HOSTING_DOMAIN:-nimbushost.com}
read -rp "Administrator email [admin@gmail.com]: " ADMIN_EMAIL
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@gmail.com}
read -rsp "Administrator password (min 8 chars, blank = bootstrap 'admin'): " ADMIN_PASSWORD
echo
read -rp "SSL via Let's Encrypt now? Requires the domain to point here [Y/n]: " SSL_CONFIRM
SSL_CONFIRM=${SSL_CONFIRM:-Y}

if [ -z "${ADMIN_PASSWORD}" ]; then
  warn "Bootstrap credentials accepted: ${ADMIN_EMAIL} / admin"
  warn "The administrator MUST change them on first login (enforced)."
  ADMIN_PASSWORD="admin"
fi
[ ${#ADMIN_PASSWORD} -ge 8 ] || [ "${ADMIN_PASSWORD}" = "admin" ] || die "Password too short (min 8 chars)."

echo
log "Installation plan:"
echo "  Panel domain : ${PANEL_DOMAIN}"
echo "  Hosting domain: ${HOSTING_DOMAIN}"
echo "  Admin email  : ${ADMIN_EMAIL}"
echo "  SSL          : $([ "${SSL_CONFIRM}" = "Y" ] && echo "Let's Encrypt" || echo "manual/none")"
read -rp "Proceed? [y/N]: " CONFIRM
[ "${CONFIRM:-n}" = "y" ] || die "Aborted by user."

# ── 3. Dependencies ──────────────────────────────────────────────
log "Installing dependencies…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git nginx >/dev/null

if ! command -v node >/dev/null || [ "$(node -e 'console.log(parseInt(process.versions.node))')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v mongod >/dev/null; then
  log "Installing MongoDB 7…"
  install -d -m 0755 /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://www.mongodb.org/static/pgp/server-7.0.asc" | gpg -o /etc/apt/keyrings/mongodb.gpg --dearmor
  echo "deb [ signed-by=/etc/apt/keyrings/mongodb.gpg ] https://repo.mongodb.org/apt/${ID} ${VERSION_CODENAME}/mongodb-org/7.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list
  apt-get update -qq && apt-get install -y -qq mongodb-org >/dev/null
  systemctl enable --now mongod
fi

if ! command -v redis-server >/dev/null; then
  apt-get install -y -qq redis-server >/dev/null
  systemctl enable --now redis-server
fi

# ── 4. Application code ──────────────────────────────────────────
log "Fetching NIMBUS (${REPO}@${BRANCH})…"
if [ -d "${INSTALL_DIR}/.git" ]; then
  git -C "${INSTALL_DIR}" fetch --depth 1 origin "${BRANCH}"
  git -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}"
else
  rm -rf "${INSTALL_DIR}"
  git clone --depth 1 -b "${BRANCH}" "https://github.com/${REPO}.git" "${INSTALL_DIR}"
fi

# ── 5. Environment & secrets ─────────────────────────────────────
JWT_SECRET=$(openssl rand -hex 48 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')
AGENT_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

if [ ! -f "${INSTALL_DIR}/.env" ]; then
  cat > "${INSTALL_DIR}/.env" <<EOF
NODE_ENV=production
PANEL_DOMAIN=${PANEL_DOMAIN}
HOSTING_DOMAIN=${HOSTING_DOMAIN}
MONGODB_URI=mongodb://localhost:27017/nimbus
JWT_SECRET=${JWT_SECRET}
AGENT_SHARED_SECRET=${AGENT_SECRET}
BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}
BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}
API_PORT=4000
WEB_URL=https://${PANEL_DOMAIN}
EOF
  chmod 600 "${INSTALL_DIR}/.env"
fi

# ── 6. Build & install ───────────────────────────────────────────
log "Building API and web frontend (this takes a few minutes)…"
cd "${INSTALL_DIR}"
npm install --no-audit --no-fund >/dev/null
npm run build --workspace @nimbus/api >/dev/null
npm run build --workspace @nimbus/web >/dev/null

id -u "${SERVICE_USER}" >/dev/null 2>&1 || useradd --system --home "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# ── 7. System services ───────────────────────────────────────────
log "Configuring systemd services…"
cat > /etc/systemd/system/nimbus-api.service <<EOF
[Unit]
Description=NIMBUS API
After=network.target mongod.service
[Service]
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=$(command -v node) ${INSTALL_DIR}/apps/api/dist/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${INSTALL_DIR}
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/nimbus-web.service <<EOF
[Unit]
Description=NIMBUS Web
After=network.target nimbus-api.service
[Service]
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=$(command -v node) ${INSTALL_DIR}/apps/web/.next/standalone/apps/web/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nimbus-api nimbus-web

# ── 8. Reverse proxy & SSL ───────────────────────────────────────
log "Configuring nginx reverse proxy…"
cat > /etc/nginx/sites-available/nimbus <<EOF
server {
  listen 80;
  server_name ${PANEL_DOMAIN};
  location /api/ { proxy_pass http://127.0.0.1:4000; proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host; }
  location / { proxy_pass http://127.0.0.1:3000; proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host; }
}
EOF
ln -sf /etc/nginx/sites-available/nimbus /etc/nginx/sites-enabled/nimbus
nginx -t && systemctl reload nginx

if [ "${SSL_CONFIRM}" = "Y" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null 2>&1 || true
  certbot --nginx -d "${PANEL_DOMAIN}" --non-interactive --agree-tos \
    -m "${ADMIN_EMAIL}" --redirect || warn "Let's Encrypt failed — configure SSL manually (docs/INSTALLATION.md)."
fi

# ── 9. Firewall guidance (never closes the admin's own session) ──
log "Firewall guidance: allow 22/tcp, 80/tcp, 443/tcp, 4001-4050/tcp+udp (service ports)."
command -v ufw >/dev/null && { ufw allow 22,80,443/tcp >/dev/null 2>&1; ufw allow 4001:4050/tcp >/dev/null 2>&1; ufw allow 4001:4050/udp >/dev/null 2>&1; } || true

# ── 10. Health check & report ────────────────────────────────────
sleep 5
HEALTH=$(curl -fs -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/api/v1/auth/me || true)
log "API health probe: HTTP ${HEALTH:-unreachable}"
systemctl is-active --quiet nimbus-api && API_OK="running" || API_OK="FAILED"
systemctl is-active --quiet nimbus-web && WEB_OK="running" || WEB_OK="FAILED"

echo
log "══════════════ Installation report ══════════════"
echo "  API service  : ${API_OK}  (port 4000)"
echo "  Web service  : ${WEB_OK}  (port 3000, proxied via nginx)"
echo "  MongoDB      : $(systemctl is-active mongod 2>/dev/null || echo '?')"
echo "  Panel URL    : https://${PANEL_DOMAIN}"
echo "  Admin login  : ${ADMIN_EMAIL} (change credentials on first login)"
echo "  Next steps   : docs/ADMIN_GUIDE.md — configure Firebase, add a node, assign services"
log "══════════════════════════════════════════════════"
