# NIMBUS Hosting Panel

> **One Platform. Every Service. Every Device. Total Control.**

NIMBUS is a hosting control panel for Minecraft, Discord bots, websites, backends,
databases, Docker apps and more — with a clean, modern dashboard for **customers**
and a powerful admin panel for **you**.

📖 **Every command in detail:** [docs/COMMANDS.md](docs/COMMANDS.md)

---

## 🚀 Installation — Step by Step

### Step 1 — Check your server

You need a **fresh Ubuntu or Debian server** (a small VPS is enough to start):

| Requirement | Minimum | Recommended |
| --- | --- | --- |
| Operating system | Ubuntu 20.04 / 22.04 / 24.04 / 26.04 LTS or Debian 11 / 12 | Ubuntu 24.04 / 26.04 LTS |
| CPU | 1 core | 2+ cores |
| RAM | 2 GB | 4–8 GB |
| Disk | 10 GB free | 20+ GB |
| Access | Root SSH access | — |

> 💡 Point your domain to the server IP **before** installing if you want a
> free HTTPS certificate (for example `panel.yourdomain.com` → server IP).

### Step 2 — Run the installer (one command)

SSH into your server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install.sh | sudo bash
```

The installer does **everything** for you: checks your system, installs
MongoDB, Node.js, Redis and nginx, builds the panel, sets up auto-start
services, configures HTTPS, and verifies everything works.

### Step 3 — Answer the wizard

The installer asks a few simple questions:

| Question | What to type | Example |
| --- | --- | --- |
| Panel domain or IP | The address you will open in your browser | `panel.yourdomain.com` |
| Hosting domain | Domain for free customer subdomains | `yourdomain.com` |
| Administrator email | Your login email | `you@yourdomain.com` |
| Administrator password | At least **8 characters** (leave empty to use the temporary `admin` password — you must change it later) | `mySecret123` |
| SSL certificate | `Y` if your domain already points to this server, otherwise `N` | `Y` |
| Proceed? | Type `y` to start | `y` |

⏱ The build takes a few minutes. When finished you get an installation report
showing every service status.

### Step 4 — Log in

1. Open `https://panel.yourdomain.com` in your browser.
2. Sign in with your email and password.
3. If you used the temporary password (`admin@gmail.com` / `admin`), the panel
   **forces** you to set a new one — do this first.

### Step 5 — Add your first server (node)

Customer services run on "nodes" — your game/application servers:

1. In the admin panel go to **Nodes → Add Node** and fill in the node's IP,
   SSH port, location and capacity.
2. Copy the **enrollment token** shown after saving (valid for 30 minutes).
3. On that node's terminal, run the command the panel shows you:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- \
  --api https://panel.yourdomain.com \
  --token <PASTE-YOUR-TOKEN-HERE>
```

4. The node appears **online** in Admin → Nodes within seconds. Now you can
   assign services to it.

---

## ⬆️ Upgrade — one command

Already installed? Upgrading is safe: it backs up your database first and
never touches customer data or your `.env` secrets.

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/upgrade.sh | sudo bash
```

## 🩺 Something not working? — one command

Run the doctor: it checks every component (services, API, web, MongoDB,
node agents, nginx, SSL, disk, security) and prints a full report. Add
`--repair` to automatically restart services that have stopped:

```bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/doctor.sh | sudo bash
curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/doctor.sh | sudo bash -s -- --repair
```

## 🔧 Everyday management commands

```bash
sudo systemctl status nimbus-api          # is the API running?
sudo systemctl status nimbus-web          # is the website running?
sudo journalctl -u nimbus-api -n 100      # last 100 API log lines
sudo bash /opt/nimbus/installer/backup.sh # back up the database now
```

More commands: [docs/COMMANDS.md](docs/COMMANDS.md) ·
Troubleshooting help: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

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
