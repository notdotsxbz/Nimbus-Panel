# NIMBUS Hosting Panel

> **One Platform. Every Service. Every Device. Total Control.**

NIMBUS is a hosting control panel for Minecraft, Discord bots, websites, backends,
databases, Docker apps and more — with a clean, modern dashboard for **customers**
and a powerful admin panel for **you**.

📖 **Every command in detail:** [docs/COMMANDS.md](docs/COMMANDS.md)

---

## 🚀 Installation

Install NIMBUS on a **fresh Ubuntu or Debian VPS** using the interactive installer.
You do not need to manually install Node.js, MongoDB, Redis, nginx, or build the
web application — the installer handles these steps.

### 1. Prepare your VPS

| Requirement | Minimum | Recommended |
| --- | --- | --- |
| OS | Ubuntu 20.04/22.04/24.04/26.04 LTS or Debian 11/12 | Ubuntu 24.04 or 26.04 LTS |
| Architecture | amd64 or arm64 | amd64 |
| CPU | 1 vCPU | 2+ vCPU |
| RAM | 4 GB | 8 GB+ when running workers |
| Free disk | 10 GB | 20 GB+ |
| Access | SSH with sudo/root privileges | Root SSH access |

Before installation:

- Create a DNS **A record** for your panel hostname pointing to the VPS public IPv4
  address (for example, `panel.example.com` → `YOUR_SERVER_IP`).
- If you use Cloudflare DNS, set the panel record to **DNS only** while requesting
  the initial Let's Encrypt certificate.
- Allow inbound **TCP 22, 80 and 443** in your VPS/cloud firewall. Keep SSH
  restricted to your own IP where possible.
- Do not expose MongoDB (27017) or Redis (6379) to the public internet.
- If your provider has a separate network firewall/security group, allow the same
  required ports there too.

> **Existing server?** The installer is designed to preserve an existing NIMBUS
> `.env` and MongoDB data when re-run. It is not a general-purpose installer for
> a server already hosting unrelated applications. Review the script before
> running it on a production machine.

### 2. Run the installer

Connect to your VPS over SSH as a user with sudo privileges, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh | sudo bash
```

If you prefer to inspect the script before executing it:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh -o nimbus-install.sh
less nimbus-install.sh
sudo bash nimbus-install.sh
```

The installer downloads and verifies its required helper files, checks the OS,
architecture, disk space and network, then opens the interactive setup wizard.
When launched through `curl | sudo bash`, it re-launches itself with the terminal
attached so that the prompts work correctly.

### 3. Complete the setup wizard

| Prompt | What to enter | Example |
| --- | --- | --- |
| Panel domain or IP | The hostname or public IP used to open the panel | `panel.example.com` |
| Hosting domain | The base domain used for customer subdomains | `example.com` |
| Administrator email | Your owner/admin login email | `admin@example.com` |
| Administrator password | Use a password with at least 8 characters | Enter a strong unique password |
| SSL via Let's Encrypt now? | Choose `Y` only when DNS points to this VPS and ports 80/443 are reachable | `Y` |
| Proceed? | Review the plan and type `y` to begin | `y` |

The installer does **not** need your Firebase, Google, or Cloudflare tokens during
this wizard. Those integrations are configured later from the panel's
**Admin → Settings** page.

### 4. What the installer configures

The installer performs the following tasks:

1. Detects the operating system and checks that its MongoDB package combination
   is supported.
2. Audits stale MongoDB APT repository entries before installing packages.
3. Installs required system packages, Node.js 22+, MongoDB and Redis (existing
   MongoDB installations are not automatically upgraded or downgraded).
4. Downloads the NIMBUS source code and creates or preserves the environment
   configuration in `/opt/nimbus/.env`.
5. Installs workspace dependencies and builds the API and web application.
6. Copies Next.js standalone **static CSS/JavaScript assets and public files**
   into the standalone runtime directory so the deployed UI is styled correctly.
7. Creates and enables the `nimbus-api` and `nimbus-web` systemd services.
8. Configures nginx as the reverse proxy and optionally requests a Let's Encrypt
   certificate.
9. Runs service health checks and prints an installation report.

The full installer log is saved at `/var/log/nimbus-install.log`.

### 5. Open NIMBUS

When the installer completes, open:

```text
https://panel.example.com
```

Sign in using the administrator email and password you entered in the wizard.
Keep your credentials private. If the installer reports that SSL issuance failed,
check DNS and firewall access for TCP 80/443, then follow the
[SSL troubleshooting guide](docs/TROUBLESHOOTING.md#ssl-error).

### 6. Configure integrations from the website

After signing in with the owner account, open **Admin → Settings**.

- **Firebase Authentication:** configure the Firebase service-account JSON and
  Firebase Web App configuration. In Firebase Console, enable the
  **Email/Password** sign-in provider. Keep the service-account private key
  secret; never paste it into a public issue, chat, or source-control commit.
- **Cloudflare:** enter a scoped API token and the Zone ID for the domain you
  want NIMBUS to manage. Do not use your Global API Key.
- **Google Drive:** enter the Google OAuth Client ID and Client Secret, then
  complete the Google authorization flow. Add the redirect URI displayed by
  NIMBUS to the OAuth client in Google Cloud Console.

These are optional integrations and are **not** required just to install or open
the panel. See the [Admin Guide](docs/ADMIN_GUIDE.md) and
[Backup Guide](docs/BACKUP_GUIDE.md) for configuration details.

### 7. Add a compute node

Customer services run on compute nodes. In the panel, go to **Admin → Nodes →
Add Node**, enter the node details, and create an enrollment token. Then run the
command shown by the panel on the node itself. The general command format is:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- \\
  --api https://panel.example.com \\
  --token YOUR_ENROLLMENT_TOKEN
```

Use the actual API URL and enrollment token generated by your panel. Treat the
token as a secret; it is single-use and expires after 30 minutes.

### 8. Upgrade, diagnose and manage

**Upgrade an existing installation** (backs up the database before updating):

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/upgrade.sh | sudo bash
```

**Run diagnostics:**

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/doctor.sh | sudo bash
```

**Apply safe automatic repairs where possible:**

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/doctor.sh | sudo bash -s -- --repair
```

**Useful service commands:**

```bash
sudo systemctl status nimbus-api nimbus-web
sudo journalctl -u nimbus-api -n 100 --no-pager
sudo journalctl -u nimbus-web -n 100 --no-pager
sudo bash /opt/nimbus/installer/backup.sh
```

For all installer options and maintenance commands, see
[docs/COMMANDS.md](docs/COMMANDS.md). For common issues, see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).


---

## 🎨 What's inside the panel

| Area | Highlights |
| --- | --- |
| **Customer dashboard** | Services at a glance, one-tap start/stop/restart, live console, file manager, backups, support tickets, dark/light themes |
| **Admin panel** | Users, roles, ban/delete, nodes (safe + owner force delete), services, allocations, domains, appearance studio, notifications, audit trail |
| **Security** | Login rate limiting, hashed passwords, session revocation on role change/ban, MongoDB user isolation, audit logs |

## 🧑‍💻 For developers

```bash
git clone https://github.com/notdotsxbz/Nimbus-Panel.git
cd Nimbus-Panel
npm install
cp .env.example .env    # fill in real values; JWT_SECRET: openssl rand -hex 48
npm run dev:api         # API  → http://localhost:4000
npm run dev:web         # UI   → http://localhost:3000
```

Requirements: **Node.js ≥ 22**, MongoDB ≥ 6, Redis ≥ 6.
Tests: `bash installer/tests/syntax-check.sh` (and the other suites in
`installer/tests/`) · all guides in the [docs/](docs/) folder.

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
