# Installation Guide

## Requirements

| Component | Minimum |
| --- | --- |
| OS | Ubuntu 20.04 / 22.04 / 24.04 / 26.04 LTS, Debian 11 / 12 |
| RAM | 4 GB (control plane), 8 GB recommended with workers |
| Disk | 10 GB free |
| Software | Node.js 22+, MongoDB (installed automatically), Redis 6+, nginx |

## Tested OS → MongoDB compatibility matrix

The installer selects the MongoDB series automatically from
`installer/lib/mongo-compat.sh` and **refuses to construct a repository for an
untested combination** (override with `MONGO_VERSION_OVERRIDE` at your own risk):

| Operating system | Codename | MongoDB series |
| --- | --- | --- |
| Ubuntu 26.04 LTS | resolute | 9.0 |
| Ubuntu 24.04 LTS | noble | 9.0 |
| Ubuntu 22.04 LTS | jammy | 9.0 |
| Ubuntu 20.04 LTS | focal | 8.0 |
| Debian 12 | bookworm | 9.0 |
| Debian 11 | bullseye | 7.0 |

Architectures: x86_64 (amd64) and aarch64 (arm64).

### MongoDB troubleshooting

- **`Release file does not exist`** — the codename is not in the matrix above.
  Upgrade the OS or use `MONGO_VERSION_OVERRIDE` consciously; the installer will
  never guess.
- **`Unit mongod.service does not exist`** — the package installation failed.
  Check `dpkg -L mongodb-org-server`. Re-running the installer resumes safely.
- **Existing MongoDB installation** — NIMBUS never upgrades or downgrades an
  existing database automatically. Version mismatches are reported as warnings.
- **Connection refused after start** — `journalctl -u mongod -n 50`; the
  installer waits up to 20 s for a local `ping` before continuing.

## One-command install

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh | sudo bash
```

The wizard asks for:

1. Panel domain or IP
2. Hosting domain (used for free `*.nimbushost.com`-style subdomains)
3. Administrator email
4. Administrator password (blank accepts bootstrap `admin@gmail.com` / `admin`, **forced to change on first login**)
5. SSL via Let's Encrypt (domain must point at the server)
6. Confirmation

The installer detects OS and resources, installs dependencies, configures MongoDB,
builds the API and web UI, registers systemd services, configures nginx + SSL,
and prints an installation report.

## Manual install (developers)

```bash
git clone https://github.com/notdotsxbz/Nimbus-Panel.git
cd Nimbus-Panel
npm install
cp .env.example .env    # fill in real values, generate JWT_SECRET with openssl rand -hex 48
npm run dev:api
npm run dev:web
```

## Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
```

## Adding a compute node

1. Admin → **Nodes → Add Node** (name, IP, SSH details, capacity).
2. Copy the single-use enrollment token (valid 30 minutes).
3. On the node:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- \
  --api https://YOUR-PANEL-DOMAIN --token <TOKEN>
```

4. The node appears ONLINE in Admin → Nodes within seconds.

## Firewall

Allow: `22/tcp` (SSH), `80,443/tcp` (panel), `4001–4050/tcp+udp` (service ports),
`7443/tcp` (node agents, node-side only). Never expose MongoDB, Redis or the Docker API.

## Management commands

| Task | Command |
| --- | --- |
| Upgrade | `sudo bash installer/upgrade.sh` |
| Backup | `sudo bash installer/backup.sh` |
| Recovery | `sudo bash installer/recovery.sh <archive> --confirm` |
| Uninstall | `sudo bash installer/uninstall.sh` |

## SSL notes

Let's Encrypt is configured automatically when chosen. HTTPS certificates secure the
panel and HTTP-based services; they do **not** encrypt raw TCP/UDP game traffic such
as Minecraft.
