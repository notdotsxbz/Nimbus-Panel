# NIMBUS Hosting Panel

> **One Platform. Every Service. Every Device. Total Control.**

NIMBUS is a professional multi-service hosting control platform with a premium
**Liquid Glass + Minimalism** interface. It pairs a lightweight central Control
Plane with secure remote Compute Nodes running a Go Node Agent.

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
| `installer/`      | One-command install / upgrade / backup / recovery |
| `docs/`           | Installation, admin, user, node, API, security…   |
| `docker/`         | Container build files for the control plane       |
| `tests/`          | Cross-cutting test suites                         |
| `.github/`        | CI + release workflows                            |

## One-command installation (Ubuntu / Debian)

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh | sudo bash
```

The wizard asks for the panel domain, admin credentials, SSL mode, database and
optional integrations, then installs MongoDB, the API, the web frontend, the
reverse proxy and system services, and prints an installation report.

> ⚠️ Default bootstrap credentials (`admin@gmail.com` / `admin`) only exist if
> explicitly accepted during install, and **must** be changed on first login.

## Adding a compute node

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- --token <ENROLLMENT_TOKEN> --api https://panel.example.com
```

Enrollment tokens are single-use and short-lived.

## Development

```bash
npm install
cp .env.example .env       # fill in real values
npm run dev:api            # NestJS API on :4000
npm run dev:web            # Next.js UI on :3000
```

Requirements: Node.js ≥ 20, MongoDB ≥ 6, Redis ≥ 6 (background jobs).
See [docs/INSTALLATION.md](docs/INSTALLATION.md) for the full guide.

## Security

- Firebase Authentication + server-side token validation, internal RBAC
- bcrypt password hashing, JWT sessions, rate limiting, CSRF-safe cookies
- Docker API never exposed publicly; customers never get host shell access
- All infrastructure operations flow through authenticated node-agent calls
- Secrets encrypted at rest; audit logs for every sensitive operation

Read [docs/SECURITY.md](docs/SECURITY.md) and [SECURITY.md](SECURITY.md)
before exposing the panel to the internet.

## License

MIT — see [LICENSE](LICENSE).
