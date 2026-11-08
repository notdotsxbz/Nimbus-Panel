# NIMBUS Hosting Panel

> **One Platform. Every Service. Every Device. Total Control.**

NIMBUS is a professional multi-service hosting control platform with a premium
**Liquid Glass + Minimalism** interface. It pairs a lightweight central Control
Plane with secure remote Compute Nodes running a Go Node Agent. Administrators
control the whole customer experience through the built-in **Theme & Animation
Studio** (10 themes, live-preview editor, animation presets) — enforced
server-side via the appearance API.

📖 **Complete command reference:** [docs/COMMANDS.md](docs/COMMANDS.md)

## Supported products

Minecraft · Discord Bots · Websites · Backends · Node.js · Python · VPS · VDS ·
MongoDB · Databases · Docker · Custom Applications — extensible through
independent service modules.

## Architecture

```
┌────────────────────────── CONTROL PLANE ──────────────────────────┐
│  apps/web      Next.js UI (Admin + Customer dashboards, PWA)      │
│  apps/api      NestJS REST API + WebSocket gateway                │
│  MongoDB       Datastore (users, nodes, services, domains, …)     │
│  Redis/BullMQ  Background jobs (backups, expirations, recovery)   │
└──────────────────────────────┬────────────────────────────────────┘
                               │  authenticated + encrypted
┌──────────────────────────────▼────────────────────────────────────┐
│  COMPUTE NODES (Ubuntu/Debian VPS)                                │
│  apps/node-agent  Go agent — containers, lifecycle, ports,        │
│                   console streaming, telemetry, backups           │
└───────────────────────────────────────────────────────────────────┘
```

## Repository layout

| Path              | Purpose                                          |
| ----------------- | ------------------------------------------------ |
| `apps/web`        | Next.js + Tailwind Liquid Glass frontend          |
| `apps/api`        | NestJS REST API, auth (Firebase + local), RBAC    |
| `apps/node-agent` | Go node agent for Ubuntu/Debian compute nodes     |
| `packages/shared` | Shared TypeScript types, enums and contracts      |
| `services/`       | Service module definitions (per product adapters) |
| `installer/`      | One-command install / node enrollment / upgrade / backup / recovery |
| `docs/`           | Installation, commands, admin, user, node, API, security… |
| `docker/`         | Container build files for the control plane       |
| `tests/`          | Live API + agent smoke suites                     |
| `installer/tests/`| Installer suites (bootstrap, OS detection, APT repair) |
| `.github/`        | CI + release workflows                            |

---

## ⚡ Production installation (Ubuntu 20.04/22.04/24.04/26.04 LTS, Debian 11/12)

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh | sudo bash
```

The wizard asks for the panel domain, hosting domain, admin credentials
(min 8 chars — short input re-prompts; bootstrap `admin@gmail.com` / `admin`
only after typing `CONFIRM`) and SSL mode. The installer is **OS-aware**:
it validates your release against the tested
[compatibility matrix](docs/INSTALLATION.md), selects a compatible MongoDB
series automatically (Ubuntu 26.04 → 9.0), **repairs stale MongoDB APT
repositories** before updating packages, verifies every step (package →
binary → `mongod.service` → connection ping), and prints an installation
report. Re-running after a failure is safe — existing data is preserved.

Pin a release for production: `sudo env NIMBUS_INSTALL_REF=<commit-sha> bash install.sh`

## 🖥 Adding a compute node

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- \
  --api https://YOUR-PANEL-DOMAIN \
  --token <ENROLLMENT_TOKEN>
```

Tokens are single-use and expire in 30 minutes (Admin → Nodes → Add Node).

## ⬆️ One-command upgrade (existing installs)

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/upgrade.sh | sudo bash
```

Backs up the database and configuration, updates the code, rebuilds both apps
(including the standalone asset copy), restarts services and verifies health.
Never touches `.env` secrets or customer data.

## 🔧 Management commands

```bash
sudo bash /opt/nimbus/installer/upgrade.sh                        # backup → update → rebuild → restart
sudo bash /opt/nimbus/installer/backup.sh                         # MongoDB dump + .env + sha256
sudo bash /opt/nimbus/installer/recovery.sh <archive> --confirm   # verified restore
sudo bash /opt/nimbus/installer/uninstall.sh                      # remove app, keep all data
bash /opt/nimbus/scripts/health-check.sh                          # API/web/MongoDB/Redis status
```

`uninstall.sh --purge-data` also deletes data and requires typing `DESTROY`.

## 🧑‍💻 Development

```bash
npm install
cp .env.example .env       # fill in real values; JWT_SECRET: openssl rand -hex 48
npm run dev:api            # NestJS API on :4000
npm run dev:web            # Next.js UI on :3000
npm run build              # production builds (shared → api → web)
npm run typecheck          # strict TypeScript checks
npm run test               # unit tests
```

Requirements: **Node.js ≥ 22**, MongoDB ≥ 6, Redis ≥ 6.
Full guide: [docs/INSTALLATION.md](docs/INSTALLATION.md) ·
Docker: `docker compose up -d --build` ·
Tests: `bash installer/tests/syntax-check.sh && bash installer/tests/mongo-compat.sh && bash installer/tests/apt-repos.sh && bash installer/tests/bootstrap.sh && bash installer/tests/os-detect.sh`

## 🎨 Appearance

Admin → **Appearance**: Theme Studio (create/edit/publish/default, live
preview), Animation Studio (presets, speed, intensity), customer permissions,
import/export. Customers: Account → **Appearance** (theme, light/dark/system,
reduced motion). All enforced server-side — see
[docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) and [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## 🔐 Security

- Firebase Authentication + server-side token validation, internal RBAC
- bcrypt password hashing, JWT sessions, rate limiting, CSRF-safe cookies
- Docker API never exposed publicly; customers never get host shell access
- All infrastructure operations flow through authenticated node-agent calls
- Secrets encrypted at rest; audit logs for every sensitive operation

Read [docs/SECURITY.md](docs/SECURITY.md) and [SECURITY.md](SECURITY.md)
before exposing the panel to the internet.

## 📚 Documentation

[Installation](docs/INSTALLATION.md) · [Commands](docs/COMMANDS.md) ·
[Admin Guide](docs/ADMIN_GUIDE.md) · [User Guide](docs/USER_GUIDE.md) ·
[Node Guide](docs/NODE_GUIDE.md) · [Domains](docs/DOMAIN_GUIDE.md) ·
[Minecraft](docs/MINECRAFT_GUIDE.md) · [Backups](docs/BACKUP_GUIDE.md) ·
[Mobile/PWA](docs/MOBILE_GUIDE.md) · [API](docs/API_GUIDE.md) ·
[Security](docs/SECURITY.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

## License

`SPDX-License-Identifier: Apache-2.0`

**License:** Apache License 2.0
Copyright 2026 Shahbaz.

This project is licensed under the Apache License, Version 2.0. You may obtain a
copy of the License at: [https://www.apache.org/licenses/LICENSE-2.0](https://www.apache.org/licenses/LICENSE-2.0)

The complete license text is in the [LICENSE](LICENSE) file at the repository root.
