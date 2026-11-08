# NIMBUS — Complete Command Reference

Every command below is verified against the repository. Target platforms:
**Ubuntu 20.04 / 22.04 / 24.04 / 26.04 LTS and Debian 11 / 12** (see the
[compatibility matrix](INSTALLATION.md)).

---

## 1. Production installation (control plane)

### One-command install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh | sudo bash
```

Works piped **and** as a downloaded file:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh -o install.sh
sudo bash install.sh
```

The wizard asks for: panel domain, hosting domain, admin email, admin password
(min 8 chars — short input re-prompts; blank accepts the bootstrap `admin` only
after typing `CONFIRM`), and SSL mode (Let's Encrypt / manual / none).

### Installer environment overrides

| Variable | Purpose | Example |
| --- | --- | --- |
| `NIMBUS_INSTALL_REF` | Pin the installer to an exact commit SHA (recommended for production) | `sudo env NIMBUS_INSTALL_REF=be48afc… bash install.sh` |
| `MONGO_VERSION_OVERRIDE` | Force a MongoDB series outside the tested matrix (your responsibility) | `sudo env MONGO_VERSION_OVERRIDE=9.0 bash install.sh` |
| `NIMBUS_RAW_BASE` | Alternate raw base URL (testing/mirrors) | internal mirrors only |

### What the installer does (in order)

Bootstraps a verified bundle (every helper file checked: non-empty + `bash -n`)
→ detects OS/architecture/kernel → validates OS support (stops on unsupported
releases **before** modifying anything) → checks root, internet, ports 3000/4000,
disk (≥10 GB) and RAM → locks against parallel runs → audits and repairs MongoDB
APT repositories (stale 7.0 entries are backed up and disabled) → installs base
dependencies → installs the selected MongoDB series with package/service/health
verification (`mongosh` ping) → Redis → clones + builds the app → `.env` with
generated secrets → systemd services → nginx + optional SSL → final health
report. Full log: `/var/log/nimbus-install.log`. Re-running after a failure is
safe (idempotent; existing `.env` and database data are never overwritten).

## 2. Adding a compute node

Admin → **Nodes → Add Node** creates the node and a single-use enrollment token
(valid 30 minutes). Then on the node:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- \
  --api https://YOUR-PANEL-DOMAIN \
  --token <ENROLLMENT_TOKEN>
```

Flags: `--api` (panel URL, required) · `--token` (enrollment token, required).
Installs Docker, builds the Go agent, generates a self-signed agent cert,
enrolls, and registers the systemd service `nimbus-agent`.

## 3. Management commands (control plane)

```bash
sudo bash /opt/nimbus/installer/upgrade.sh                        # backup → update → build → restart
sudo bash /opt/nimbus/installer/backup.sh [DEST_DIR]              # mongodump + .env snapshot + sha256
sudo bash /opt/nimbus/installer/recovery.sh <archive> --confirm   # restore (checksum-verified, explicit)
sudo bash /opt/nimbus/installer/uninstall.sh                      # remove app, KEEP all data
sudo bash /opt/nimbus/installer/uninstall.sh --purge-data         # also delete data — requires typing DESTROY
```

Notes: `upgrade.sh` backs up MongoDB before touching anything. `recovery.sh`
keeps a pre-restore safety dump. `uninstall.sh` never deletes customer data
without the explicit `--purge-data` + `DESTROY` confirmation.

## 4. Health & maintenance

```bash
bash /opt/nimbus/scripts/health-check.sh    # API + web + mongod + redis status
sudo bash /opt/nimbus/scripts/rotate-logs.sh  # rotate/compress panel + nginx logs (cron weekly)
systemctl status nimbus-api nimbus-web      # service state
journalctl -u nimbus-api -n 50              # API logs
journalctl -u mongod -n 50                  # MongoDB logs
```

## 5. Development

```bash
git clone https://github.com/notdotsxbz/Nimbus-Panel.git
cd Nimbus-Panel
npm install                  # installs all workspaces (Node.js ≥ 22)
cp .env.example .env         # fill in real values; generate JWT_SECRET: openssl rand -hex 48

npm run dev:api              # NestJS API  → http://localhost:4000
npm run dev:web              # Next.js UI  → http://localhost:3000

npm run build                # shared → api → web (production builds)
npm run typecheck            # TypeScript strict checks (all workspaces)
npm run lint                 # ESLint where configured
npm run test                 # shared package unit tests
```

Per-workspace: `npm run build --workspace @nimbus/web`, `npm run start:dev
--workspace @nimbus/api`, etc.

## 6. Docker (evaluation / self-hosted)

```bash
cp .env.example .env          # set JWT_SECRET + AGENT_SHARED_SECRET (required)
docker compose up -d --build  # mongodb + redis + api(:4000) + web(:3000)
```

## 7. Tests

```bash
# Unit + integration (real API against real MongoDB)
npm run test --workspace @nimbus/shared      # contracts, themes, presets (8 tests)

# Live API smoke suite (needs API running; defaults to :4100)
set MONGODB_URI=mongodb://127.0.0.1:27017/nimbus-smoke
set JWT_SECRET=<random> && set AGENT_SHARED_SECRET=<random> && set API_PORT=4100
node apps/api/dist/main.js &                 # or npm run start:dev --workspace @nimbus/api
node tests/api-smoke.mjs                     # 30 checks: auth, RBAC, domains, appearance
set AGENT_SHARED_SECRET=<same> && node tests/agent-enrollment-smoke.mjs   # 9 checks

# Installer suites (real bash, fully mocked — safe anywhere)
bash installer/tests/syntax-check.sh         # bash -n on every shell script
bash installer/tests/mongo-compat.sh         # OS → MongoDB matrix (25 checks)
bash installer/tests/apt-repos.sh            # stale-repo audit/repair (24 checks)
bash installer/tests/bootstrap.sh            # piped + downloaded execution (16 checks)
bash installer/tests/os-detect.sh            # OS detection + strict-mode regressions (18 checks)
```

## 8. Security scan

```bash
npm audit --audit-level=low   # must report 0 vulnerabilities
grep -rInE "(sk_live|AKIA[0-9A-Z]{16}|-----BEGIN (RSA )?PRIVATE KEY-----)" \
  --include="*.ts" --include="*.go" --include="*.sh" apps packages installer
```

## 9. Appearance (Theme & Animation Studio)

No CLI — everything is managed in the panel:
Admin → **Appearance** (themes, publish/default, animation presets, customer
permissions, import/export) · Account → **Appearance** (customer theme, light/
dark/system, reduced motion). API surface: `GET|POST /api/v1/appearance/*` —
see [API_GUIDE.md](API_GUIDE.md).

## 10. Useful environment variables (`.env`)

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Session signing key (`openssl rand -hex 48`) |
| `AGENT_SHARED_SECRET` | Node-agent enrollment/heartbeat signing |
| `MONGODB_URI` | MongoDB connection string |
| `PANEL_DOMAIN` / `HOSTING_DOMAIN` | Panel + free-subdomain domains |
| `FIREBASE_ADMIN_CREDENTIALS_BASE64` | Optional Firebase Authentication |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` | Optional scoped DNS management |
| `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` | Optional Google Drive backups |
| `DEFAULT_PORT_RANGE_START/END` | Service port allocation pool (default 4001–4050) |

Full template: [`.env.example`](../.env.example).
