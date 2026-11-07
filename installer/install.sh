#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS Hosting Panel — One-Command Installer (Ubuntu / Debian)
#
#  curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh | sudo bash
#
#  - OS-aware MongoDB selection (installer/lib/mongo-compat.sh)
#  - Idempotent steps; safe to re-run after a failure
#  - Never destroys customer data; never auto-upgrades an existing DB
# ═══════════════════════════════════════════════════════════════════
set -Eeuo pipefail

REPO="notdotsxbz/Nimbus-Panel"
BRANCH="main"
INSTALL_DIR="/opt/nimbus"
SERVICE_USER="nimbus"
INSTALL_LOG="/var/log/nimbus-install.log"
CURRENT_STEP="initialising"

log()  { printf '\033[1;37m[nimbus]\033[0m %s\n' "$*" | tee -a "${INSTALL_LOG}" 2>/dev/null || printf '\033[1;37m[nimbus]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[nimbus]\033[0m %s\n' "$*" | tee -a "${INSTALL_LOG}" 2>/dev/null || printf '\033[1;33m[nimbus]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[nimbus] ERROR:\033[0m %s\n' "$*" >&2; printf '[nimbus] ERROR: %s\n' "$*" >> "${INSTALL_LOG}" 2>/dev/null || true; exit 1; }
step() { CURRENT_STEP="$1"; echo; log "── ${CURRENT_STEP}"; }

on_error() {
  local exit_code=$? line_no=${1:-?}
  printf '\033[1;31m[nimbus] ERROR:\033[0m installation failed in step "%s" (line %s, exit %s).\n' \
    "${CURRENT_STEP}" "${line_no}" "${exit_code}" >&2
  printf '\033[1;33m[nimbus]\033[0m Existing data was preserved. Fix the issue and re-run the installer — steps are idempotent.\n' >&2
  printf '\033[1;33m[nimbus]\033[0m Full log: %s\n' "${INSTALL_LOG}" >&2
  exit "${exit_code}"
}
trap 'on_error $LINENO' ERR

# ── 0. Interactive-terminal guard ────────────────────────────────
# When launched as `curl … | sudo bash`, stdin is the PIPE containing the
# script itself — every `read` would consume script text instead of user
# input (producing bogus "Password too short" aborts or garbage credentials).
# Re-exec from a downloaded file with prompts attached to the terminal.
if [ ! -t 0 ]; then
  if [ ! -e /dev/tty ]; then
    die "No interactive terminal detected. Download the script and run it directly: sudo bash install.sh"
  fi
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
    || die "Neither curl nor wget is available to fetch the installer."
  TMP_INSTALLER=$(mktemp /tmp/nimbus-install-XXXXXX.sh)
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/installer/install.sh" -o "${TMP_INSTALLER}"
  else
    wget -qO "${TMP_INSTALLER}" "https://raw.githubusercontent.com/${REPO}/${BRANCH}/installer/install.sh"
  fi
  printf '[nimbus] Re-launching installer from a file so prompts can read your terminal…\n'
  exec bash "${TMP_INSTALLER}" </dev/tty
fi

# Prompts must NEVER read from piped stdin — always prefer the terminal.
tty_read() {
  if [ -t 0 ]; then
    read "$@"
  else
    read "$@" </dev/tty
  fi
}

[ "$(id -u)" -eq 0 ] || die "Run with sudo (the installer configures system services)."
touch "${INSTALL_LOG}" && chmod 600 "${INSTALL_LOG}" || true

# ── 1. System detection & supported-OS validation ────────────────
step "System detection and OS support validation"
OS_ID="" OS_VERSION_ID="" OS_CODENAME="" OS_PRETTY="unknown" ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}" OS_VERSION_ID="${VERSION_ID:-}" OS_CODENAME="${VERSION_CODENAME:-}" OS_PRETTY="${PRETTY_NAME:-unknown}"
fi
TOTAL_RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
CPU_CORES=$(nproc)
DISK_GB=$(df -BG / | awk 'NR==2 {print int($4)}')
PKG_MANAGER="apt"
command -v apt-get >/dev/null 2>&1 || PKG_MANAGER="none"

echo "  Operating system : ${OS_PRETTY}"
echo "  OS id / version  : ${OS_ID} ${OS_VERSION_ID} (${OS_CODENAME:-no codename})"
echo "  Architecture     : ${ARCH}"
echo "  CPU cores        : ${CPU_CORES}"
echo "  Available RAM    : ${TOTAL_RAM_MB} MB"
echo "  Available disk   : ${DISK_GB} GB"
echo "  Package manager  : ${PKG_MANAGER}"

[ "${PKG_MANAGER}" = "apt" ] || die "apt-get is required — this installer supports Ubuntu and Debian only (detected: ${PKG_MANAGER})."

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# When re-exec'd from a temp file the lib lives next to the script; prefer repo copy.
if [ -f "${SCRIPT_DIR}/lib/mongo-compat.sh" ]; then
  # shellcheck disable=SC1091
  . "${SCRIPT_DIR}/lib/mongo-compat.sh"
elif [ -f "${INSTALL_DIR}/installer/lib/mongo-compat.sh" ]; then
  # shellcheck disable=SC1091
  . "${INSTALL_DIR}/installer/lib/mongo-compat.sh"
else
  die "installer/lib/mongo-compat.sh not found next to the installer."
fi

if select_mongodb_compat "/etc/os-release" "${ARCH}"; then
  echo "  Compatibility    : SUPPORTED — ${MONGO_REASON}"
else
  echo "  Compatibility    : NOT SUPPORTED"
  echo
  die "Unsupported platform: ${MONGO_REASON}
Nothing was modified on this server."
fi

if [ "${TOTAL_RAM_MB}" -lt 3500 ]; then
  warn "Less than 4 GB RAM detected — the control plane may be tight. 8 GB is recommended with workers."
fi
[ "${DISK_GB}" -ge 10 ] || die "At least 10 GB free disk is required."

# Allow an explicit override for environments outside the tested matrix.
MONGO_VERSION_OVERRIDE="${MONGO_VERSION_OVERRIDE:-}"

# ── 2. Installation wizard ───────────────────────────────────────
step "Installation wizard"
echo
tty_read -rp "Panel domain or IP [panel.example.com]: " PANEL_DOMAIN || PANEL_DOMAIN=""
PANEL_DOMAIN=$(printf '%s' "${PANEL_DOMAIN:-panel.example.com}" | tr -d '\r')
tty_read -rp "Hosting domain for free subdomains [nimbushost.com]: " HOSTING_DOMAIN || HOSTING_DOMAIN=""
HOSTING_DOMAIN=$(printf '%s' "${HOSTING_DOMAIN:-nimbushost.com}" | tr -d '\r')
tty_read -rp "Administrator email [admin@gmail.com]: " ADMIN_EMAIL || ADMIN_EMAIL=""
ADMIN_EMAIL=$(printf '%s' "${ADMIN_EMAIL:-admin@gmail.com}" | tr -d '\r')

# Password policy: min 8 chars, or the explicitly accepted bootstrap password.
# Short input RE-PROMPTS instead of aborting the whole installation.
while true; do
  tty_read -rsp "Administrator password (min 8 chars, blank = bootstrap 'admin'): " ADMIN_PASSWORD || ADMIN_PASSWORD=""
  echo
  ADMIN_PASSWORD="${ADMIN_PASSWORD%$'\r'}"
  if [ -z "${ADMIN_PASSWORD}" ]; then
    warn "Bootstrap credentials accepted: ${ADMIN_EMAIL} / admin"
    warn "The administrator MUST change them on first login (enforced by the panel)."
    tty_read -rp "Type CONFIRM to accept the bootstrap password: " BOOTSTRAP_CONFIRM || BOOTSTRAP_CONFIRM=""
    if [ "$(printf '%s' "${BOOTSTRAP_CONFIRM:-}" | tr -d '\r')" = "CONFIRM" ]; then
      ADMIN_PASSWORD="admin"
      break
    fi
    warn "Bootstrap not confirmed — enter a real password."
    continue
  fi
  if [ "${#ADMIN_PASSWORD}" -ge 8 ]; then
    break
  fi
  warn "Password too short (min 8 chars, ${#ADMIN_PASSWORD} entered) — please try again (Ctrl+C to abort)."
done
tty_read -rp "SSL via Let's Encrypt now? Requires the domain to point here [Y/n]: " SSL_CONFIRM || SSL_CONFIRM=""
SSL_CONFIRM=$(printf '%s' "${SSL_CONFIRM:-Y}" | tr -d '\r')

echo
log "Installation plan:"
echo "  Panel domain  : ${PANEL_DOMAIN}"
echo "  Hosting domain: ${HOSTING_DOMAIN}"
echo "  Admin email   : ${ADMIN_EMAIL}"
echo "  MongoDB       : ${MONGO_VERSION_OVERRIDE:-auto (${MONGO_VERSION} series for ${MONGO_CODENAME})}"
echo "  SSL           : $([ "${SSL_CONFIRM}" = "Y" ] && echo "Let's Encrypt" || echo "manual/none")"
tty_read -rp "Proceed? [y/N]: " CONFIRM || CONFIRM="n"
[ "$(printf '%s' "${CONFIRM:-n}" | tr -d '\r')" = "y" ] || die "Aborted by user."

# ── 3. Base dependencies ─────────────────────────────────────────
step "Base dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || die "apt-get update failed — check network connectivity and repository health (manually run: apt-get update)."
apt-get install -y -qq ca-certificates curl gnupg git nginx >/dev/null

# Node.js 22 (required by the API and web stacks)
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  [ "${NODE_MAJOR}" -ge 22 ] && NEED_NODE=0
fi
if [ "${NEED_NODE}" -eq 1 ]; then
  log "Installing Node.js 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
command -v node >/dev/null 2>&1 || die "Node.js installation failed — see ${INSTALL_LOG}."

# ── 4. MongoDB (OS-aware, validated, health-checked) ─────────────
step "MongoDB installation and health verification"

MONGO_SERIES="${MONGO_VERSION_OVERRIDE:-${MONGO_VERSION}}"
if [ -n "${MONGO_VERSION_OVERRIDE}" ]; then
  warn "Using explicit override: MongoDB ${MONGO_SERIES} (MONGO_VERSION_OVERRIDE) — unsupported combinations are your responsibility."
fi

ensure_mongodb() {
  # Idempotent: install official mongodb-org only if absent; never touch data.
  if command -v mongod >/dev/null 2>&1; then
    INSTALLED_SERIES=$(mongod --version 2>/dev/null | awk '/db version/ {print $3}' | cut -d. -f1,2)
    log "MongoDB already installed (db version ${INSTALLED_SERIES}) — not upgrading or downgrading automatically."
    if [ "${INSTALLED_SERIES}" != "${MONGO_SERIES}" ]; then
      warn "Installed series ${INSTALLED_SERIES} differs from the recommended ${MONGO_SERIES} for this OS."
      warn "NIMBUS never upgrades/downgrades a production database automatically. Verify compatibility at:"
      warn "https://www.mongodb.com/docs/community-platform-support/"
    fi
  else
    log "Installing official MongoDB ${MONGO_SERIES} for ${OS_ID} ${OS_CODENAME} (${ARCH})…"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_SERIES}.asc" \
      | gpg --dearmor --yes -o /etc/apt/keyrings/mongodb-server-${MONGO_SERIES}.gpg
    chmod 0644 /etc/apt/keyrings/mongodb-server-${MONGO_SERIES}.gpg
    local repo_list="/etc/apt/sources.list.d/mongodb-org-${MONGO_SERIES}.list"
    echo "deb [ arch=${ARCH} signed-by=/etc/apt/keyrings/mongodb-server-${MONGO_SERIES}.gpg ] https://repo.mongodb.org/apt/${OS_ID} ${MONGO_CODENAME}/mongodb-org/${MONGO_SERIES} multiverse" \
      > "${repo_list}"
    # Remove stale mongodb list files from earlier failed attempts (only ours)
    find /etc/apt/sources.list.d -maxdepth 1 -name 'mongodb-org-*.list' ! -name "$(basename "${repo_list}")" -delete 2>/dev/null || true

    log "Refreshing APT package lists…"
    apt-get update -qq || die "apt-get update failed after adding the MongoDB ${MONGO_SERIES} repository. This usually means the codename/architecture combination has no official packages. Check https://repo.mongodb.org/apt/${OS_ID}/dists/${MONGO_CODENAME}/mongodb-org/${MONGO_SERIES}/ exists."
    apt-get install -y -qq mongodb-org || die "mongodb-org installation failed. Check APT output above; existing data was not touched."
  fi

  # Package verification
  dpkg -s mongodb-org-server >/dev/null 2>&1 || die "mongodb-org-server package is not installed after installation — APT reported success but the package is missing."
  [ -x "$(command -v mongod)" ] || die "mongod executable not found on PATH after installation."

  # Service verification
  systemctl daemon-reload || true
  if ! systemctl list-unit-files 2>/dev/null | grep -q '^mongod.service'; then
    die "mongod.service unit does not exist even though the package is installed. Check: dpkg -L mongodb-org-server | grep systemd"
  fi
  if ! systemctl is-active --quiet mongod; then
    log "Starting mongod…"
    systemctl enable mongod >/dev/null 2>&1 || die "Failed to enable mongod.service."
    systemctl start mongod || die "Failed to start mongod.service — inspect: journalctl -u mongod -n 50"
  fi
  systemctl is-active --quiet mongod || die "mongod.service is not active after start attempt."

  # Health + connectivity check
  local tries=0
  until mongosh --quiet --eval "db.runCommand({ ping: 1 }).ok" 2>/dev/null | grep -q '^1$'; do
    tries=$((tries + 1))
    [ "${tries}" -ge 10 ] && die "MongoDB is running but did not accept a local connection within 20 s — inspect: journalctl -u mongod -n 50"
    sleep 2
  done
  log "MongoDB ${MONGO_SERIES} is active and accepting connections."
}
ensure_mongodb

# ── 5. Redis ─────────────────────────────────────────────────────
step "Redis"
if ! command -v redis-server >/dev/null 2>&1; then
  apt-get install -y -qq redis-server >/dev/null
fi
systemctl enable --now redis-server >/dev/null 2>&1 || true
systemctl is-active --quiet redis-server && log "Redis is active." || warn "Redis is not active — background jobs will queue until it starts."

# ── 6. Application code ──────────────────────────────────────────
step "Application code"
log "Fetching NIMBUS (${REPO}@${BRANCH})…"
if [ -d "${INSTALL_DIR}/.git" ]; then
  git -C "${INSTALL_DIR}" fetch --depth 1 origin "${BRANCH}"
  git -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}"
else
  rm -rf "${INSTALL_DIR}"
  git clone --depth 1 -b "${BRANCH}" "https://github.com/${REPO}.git" "${INSTALL_DIR}"
fi

# ── 7. Environment & secrets ─────────────────────────────────────
step "Environment and secrets"
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
  log "Environment file created."
else
  log "Existing .env preserved (secrets and configuration untouched)."
fi

# ── 8. Build ─────────────────────────────────────────────────────
step "Building API and web frontend (this takes a few minutes)"
cd "${INSTALL_DIR}"
npm install --no-audit --no-fund >/dev/null
npm run build >/dev/null

id -u "${SERVICE_USER}" >/dev/null 2>&1 || useradd --system --home "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# ── 9. System services ───────────────────────────────────────────
step "System services"
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
systemctl enable --now nimbus-api nimbus-web >/dev/null 2>&1 || true

# ── 10. Reverse proxy & SSL ──────────────────────────────────────
step "Reverse proxy and SSL"
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
nginx -t || die "nginx configuration test failed — check /etc/nginx/sites-available/nimbus."
systemctl reload nginx

if [ "${SSL_CONFIRM}" = "Y" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null 2>&1 || true
  certbot --nginx -d "${PANEL_DOMAIN}" --non-interactive --agree-tos \
    -m "${ADMIN_EMAIL}" --redirect || warn "Let's Encrypt failed — configure SSL manually (docs/INSTALLATION.md)."
fi

# ── 11. Firewall guidance (never closes the admin's own session) ─
step "Firewall guidance"
log "Firewall guidance: allow 22/tcp, 80/tcp, 443/tcp, 4001-4050/tcp+udp (service ports)."
command -v ufw >/dev/null && { ufw allow 22,80,443/tcp >/dev/null 2>&1; ufw allow 4001:4050/tcp >/dev/null 2>&1; ufw allow 4001:4050/udp >/dev/null 2>&1; } || true

# ── 12. Health check & report ────────────────────────────────────
step "Health check and installation report"
sleep 5
HEALTH=$(curl -fs -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/api/v1/auth/me || true)
log "API health probe: HTTP ${HEALTH:-unreachable}"
systemctl is-active --quiet nimbus-api && API_OK="running" || API_OK="FAILED"
systemctl is-active --quiet nimbus-web && WEB_OK="running" || WEB_OK="FAILED"
systemctl is-active --quiet mongod && MONGO_OK="active" || MONGO_OK="FAILED"

echo
log "══════════════ Installation report ══════════════"
echo "  OS / arch     : ${OS_PRETTY} (${ARCH})"
echo "  API service   : ${API_OK}  (port 4000)"
echo "  Web service   : ${WEB_OK}  (port 3000, proxied via nginx)"
echo "  MongoDB       : ${MONGO_OK}  (series ${INSTALLED_SERIES:-${MONGO_SERIES}})"
echo "  Redis         : $(systemctl is-active redis-server 2>/dev/null || echo '?')"
echo "  Panel URL     : https://${PANEL_DOMAIN}"
echo "  Admin login   : ${ADMIN_EMAIL} (change credentials on first login)"
echo "  Full log      : ${INSTALL_LOG}"
echo "  Next steps    : docs/ADMIN_GUIDE.md — configure Firebase, add a node, assign services"
log "══════════════════════════════════════════════════"
[ "${API_OK}" = "running" ] && [ "${MONGO_OK}" = "active" ] || die "Installation finished but core services are unhealthy — see the report above. Re-run the installer to resume; data was preserved."
