# NIMBUS Hosting Panel

> **One Platform. Every Service. Every Device. Total Control.**

NIMBUS is a hosting control panel for Minecraft, Discord bots, websites, backends,
databases, Docker apps and more — with a clean, modern dashboard for **customers**
and a powerful admin panel for **you**.

📖 **Every command in detail:** [docs/COMMANDS.md](docs/COMMANDS.md)

---

## 🚀 Installation

Install NIMBUS on a **supported Ubuntu or Debian VPS** with the interactive installer.
The installer prepares the control plane, including Node.js, MongoDB, Redis, the API,
the Next.js web app, systemd services and nginx.

### 1. VPS requirements

| Requirement | Minimum / supported |
| --- | --- |
| Operating system | Ubuntu 20.04, 22.04, 24.04 or 26.04; Debian 11 or 12 |
| Architecture | amd64 (x86_64) or arm64 (aarch64) |
| RAM | 4 GB recommended minimum; 8 GB recommended when running workers |
| Free disk | At least 10 GB |
| Access | SSH account with sudo/root privileges |
| Network | Internet access; TCP 22, 80 and 443 for SSH and the panel |

The installer checks the OS/MongoDB compatibility matrix and stops on unsupported
OS/codename combinations. It selects the MongoDB series automatically; do not force
a different series unless you understand the compatibility risk.

Before installing:

- Create a DNS **A record** for your panel hostname pointing to the VPS public IPv4
  address (for example, `panel.example.com` → `YOUR_SERVER_IP`).
- If the DNS record is proxied through Cloudflare, temporarily set it to **DNS only**
  while requesting the initial Let's Encrypt certificate.
- Allow inbound **TCP 22, 80 and 443** in your cloud firewall/security group. Keep
  SSH restricted to your own IP where possible.
- Do not expose MongoDB (27017), Redis (6379), or the Docker API to the public internet.
- Compute nodes also need the service ports configured for the services you host
  (default TCP/UDP 4001–4050); see [docs/INSTALLATION.md](docs/INSTALLATION.md).

> **Existing VPS:** The installer is designed for NIMBUS and preserves an existing
> `/opt/nimbus/.env` and MongoDB data when re-run. It is not intended as a general
> installer on a server running unrelated applications. Review the script first.
> The installer updates the NIMBUS Git checkout to the selected repository branch.

### 2. Download and run the installer

Connect to the VPS over SSH, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh | sudo bash
```

To inspect the installer before running it:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh -o nimbus-install.sh
less nimbus-install.sh
sudo bash nimbus-install.sh
```

The one-line command downloads a verified installer bundle and re-launches it with
your terminal attached so the interactive prompts work correctly.

### 3. Complete the setup wizard

| Prompt | What to enter |
| --- | --- |
| Panel domain or IP | Hostname or public IP used to open the panel |
| Hosting domain | Base domain used for customer subdomains |
| Administrator email | Owner/admin login email |
| Administrator password | Enter a unique password of at least 8 characters |
| SSL via Let's Encrypt now? | Answer `Y` only after DNS points to this VPS and TCP 80/443 are reachable |
| Proceed? | Review the installation plan and type `y` |

You can leave the administrator password blank only if you explicitly type
`CONFIRM` when asked. This accepts the temporary bootstrap password `admin`,
which the panel requires you to change at first login. **Use a unique password
instead whenever possible.**

Firebase, Cloudflare and Google Drive credentials are not needed during installation.
Configure optional integrations after signing in.

### 4. What the installer does

The current `installer/install.sh` workflow:

1. Checks the OS, architecture, available disk space and network connectivity.
2. Selects the MongoDB package series for the supported OS/codename and audits
   conflicting MongoDB APT repository entries.
3. Installs required base packages, Node.js 22+, MongoDB and Redis.
   An existing MongoDB installation is not automatically upgraded or downgraded.
4. Clones or updates the NIMBUS source in `/opt/nimbus`.
5. Creates `/opt/nimbus/.env` with generated secrets on a new installation.
   On a re-run, an existing `.env` is preserved.
6. Installs workspace dependencies and builds the API and web application.
7. Copies Next.js standalone static assets and public files into the runtime
   directory so the deployed UI can load its CSS and JavaScript.
8. Creates and enables the `nimbus-api` and `nimbus-web` systemd services.
9. Configures nginx and optionally requests a Let's Encrypt certificate.
10. Prints service status and the panel URL.

Full installation log: `/var/log/nimbus-install.log`.

### 5. Open the panel

When installation completes, open your configured URL, for example:

```text
https://panel.example.com
```

Sign in with the administrator email and password from the wizard. If you used
the temporary bootstrap password, change it immediately. If the panel does not
load or SSL issuance fails, check the service logs and the
[troubleshooting guide](docs/TROUBLESHOOTING.md).

### 6. Configure optional integrations

After signing in with an owner/admin account, open **Admin → Settings**. These
integrations are configured in the website; they are not part of the VPS installer.

- **Firebase Authentication:** create/select a Firebase project, enable the
  **Email/Password** provider, add your panel hostname to Firebase Authentication's
  authorized domains, and provide the Firebase Web App configuration plus the
  Firebase Admin service-account JSON in the Firebase settings. Treat the JSON
  private key as a secret; never commit it to GitHub or paste it into public chats.
  If Google Cloud blocks service-account key creation through an organization
  policy, the project administrator must review that policy, or use a project
  where key creation is permitted. Do not try to bypass an organization policy.
- **Cloudflare:** provide a narrowly scoped API token and the Zone ID for the
  domain NIMBUS should manage. Do **not** use your Global API Key.
- **Google Drive:** provide the Google OAuth Client ID and Client Secret, then
  complete the authorization flow. Add the exact redirect URI shown by NIMBUS
  to the OAuth client in Google Cloud Console.

For configuration details, see the
[Admin Guide](docs/ADMIN_GUIDE.md) and [Backup Guide](docs/BACKUP_GUIDE.md).

### 7. Add a compute node

Customer workloads run on compute nodes. In the panel, open **Admin → Nodes →
Add Node**, create the node and generate its enrollment token. On the compute
node itself, run the command shown by the panel. The general command format is:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- \\
  --api https://panel.example.com \\
  --token YOUR_ENROLLMENT_TOKEN
```

Use the actual panel URL and token generated by NIMBUS. Treat the token as a
secret; the enrollment token is single-use and expires after 30 minutes.
The node installer supports Ubuntu and Debian, installs Docker and the NIMBUS
agent, and registers `nimbus-agent` as a systemd service. Check **Admin → Nodes**
to verify the node comes online.

### 8. Upgrade, back up and diagnose

**Upgrade an existing NIMBUS installation** (the upgrade script backs up the
MongoDB database and `.env` before updating code):

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/upgrade.sh | sudo bash
```

**Run a diagnostic report:**

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/doctor.sh | sudo bash
```

**Run diagnostics and attempt safe service-restart repairs:**

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/doctor.sh | sudo bash -s -- --repair
```

**Create a control-plane backup:**

```bash
sudo bash /opt/nimbus/installer/backup.sh
```

**Useful service commands:**

```bash
sudo systemctl status nimbus-api nimbus-web mongod redis-server
sudo journalctl -u nimbus-api -n 100 --no-pager
sudo journalctl -u nimbus-web -n 100 --no-pager
```

See [docs/COMMANDS.md](docs/COMMANDS.md) for the complete command reference and
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for common issues.
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
