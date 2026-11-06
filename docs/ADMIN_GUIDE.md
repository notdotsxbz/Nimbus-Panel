# Administrator Guide

## First login

1. Open `https://your-panel-domain` — you land on the single common login page.
2. Sign in with the credentials from installation. If you accepted the bootstrap
   credentials (`admin@gmail.com` / `admin`), the panel **forces** a credential change.
3. Change the password immediately under **Account Settings**.

## Configure Firebase (optional)

Local bcrypt login works out of the box. To enable Firebase Authentication:

1. Create a Firebase project → enable **Email/Password** (and any other providers).
2. Admin → **Settings → Firebase** and set the environment variables:
   - `NEXT_PUBLIC_FIREBASE_*` (web config)
   - `FIREBASE_ADMIN_CREDENTIALS_BASE64` (base64 of the service-account JSON)
3. Add your panel domain to Firebase **Authorized domains**.
4. Restart the API. Private credentials never reach the browser; internal
   permissions (RBAC) stay in the NIMBUS database, separate from Firebase.

## Add a node

1. Admin → **Nodes → Add Node**: name, IP, SSH port/user, OS, location, capacity (CPU/RAM/disk).
2. Copy the enrollment token (single-use, 30-minute expiry).
3. Run `install-node.sh` on the node (see INSTALLATION.md).
4. Node heartbeats arrive every 15 s — CPU, RAM, disk, containers and agent health.

## Allocate IPs and ports

Admin → **Allocations**. Default range 4001–4050, configurable via
`DEFAULT_PORT_RANGE_START/END`. Uniqueness is enforced per node+IP+port+protocol.
Allocate manually or let the auto-allocator pick the next free port.

## Create users and assign services

1. Admin → **Users → Add Customer** (username is unique, case-insensitive).
2. Admin → **All Services → Assign Service** — the wizard checks real node capacity
   and only offers healthy nodes that can actually fit the requested RAM/disk.
3. Choose type, software/version, resources, duration, then assign. The node agent
   installs the container and reports the real status back.

## Domains

- **Default domain**: set `HOSTING_DOMAIN` during install. Customers automatically
  receive `play-username.*`, `username.*`, `api-username.*`, `bot-username.*`.
- **Custom domains**: customers add them under My Domains; ownership is verified by a
  TXT record. With a scoped Cloudflare token configured, records are managed via API.
- **SSL**: issued automatically for HTTP services (not raw TCP game traffic).

## Backups

Admin → **Backups** shows every snapshot. Configure Google Drive (OAuth) or S3 in
Settings; refresh tokens are encrypted at rest. Restores stage before replacing data.

## Upgrades and recovery

```bash
sudo bash installer/upgrade.sh    # backs up first, never destroys data
sudo bash installer/recovery.sh <archive> --confirm
```
