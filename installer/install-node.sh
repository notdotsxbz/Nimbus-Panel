#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS Node Installer — run on each Ubuntu/Debian compute node
#
#  curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- \
#    --api https://panel.example.com --token <ENROLLMENT_TOKEN>
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="notdotsxbz/Nimbus-Panel"
API_URL=""; TOKEN=""

log() { printf '\033[1;37m[nimbus-node]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[nimbus-node] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."

while [ $# -gt 0 ]; do
  case "$1" in
    --api)   API_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[ -n "${API_URL}" ] && [ -n "${TOKEN}" ] || die "Usage: --api https://panel:port --token TOKEN"

. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) log "Detected ${PRETTY_NAME}" ;;
  *) die "Only Ubuntu and Debian nodes are supported." ;;
esac

log "Installing Docker…"
if ! command -v docker >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/${ID}/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null
  systemctl enable --now docker
fi

# Docker API is NEVER exposed publicly.
if ss -ltn 2>/dev/null | grep -q '0.0.0.0:2375\|0.0.0.0:2376'; then
  die "Docker TCP API is exposed — remove that configuration before enrolling (security requirement)."
fi

log "Building node agent…"
apt-get install -y -qq golang-go >/dev/null 2>&1 || { snap install go --classic >/dev/null 2>&1; }
WORK=$(mktemp -d)
git clone --depth 1 "https://github.com/${REPO}.git" "${WORK}/nimbus"
cd "${WORK}/nimbus/apps/node-agent"
go build -o /usr/local/bin/nimbus-agent .
chmod +x /usr/local/bin/nimbus-agent

mkdir -p /etc/nimbus /var/lib/nimbus/services /var/lib/nimbus/backups
chmod 750 /var/lib/nimbus

log "Generating agent TLS certificate (self-signed, agent-local)…"
openssl req -x509 -newkey rsa:2048 -keyout /etc/nimbus/agent.key -out /etc/nimbus/agent.crt \
  -days 825 -nodes -subj "/CN=nimbus-agent" 2>/dev/null
chmod 600 /etc/nimbus/agent.key

log "Enrolling with ${API_URL}…"
NIMBUS_API_URL="${API_URL}" NIMBUS_ENROLLMENT_TOKEN="${TOKEN}" /usr/local/bin/nimbus-agent --api "${API_URL}" --token "${TOKEN}" --dry-run 2>/dev/null \
  || true   # enrollment runs inside the service on first start

cat > /etc/systemd/system/nimbus-agent.service <<EOF
[Unit]
Description=NIMBUS Node Agent
After=network.target docker.service
Requires=docker.service
[Service]
ExecStart=/usr/local/bin/nimbus-agent --api ${API_URL} --token ${TOKEN}
Environment=NIMBUS_API_URL=${API_URL}
Environment=NIMBUS_ENROLLMENT_TOKEN=${TOKEN}
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/nimbus /etc/nimbus
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nimbus-agent

log "Firewall guidance: allow your service port range (default 4001-4050 tcp+udp)."
command -v ufw >/dev/null && { ufw allow 4001:4050/tcp >/dev/null 2>&1; ufw allow 4001:4050/udp >/dev/null 2>&1; ufw allow 7443/tcp >/dev/null 2>&1; } || true

log "Node enrolled. Verify it shows ONLINE in Admin → Nodes."
