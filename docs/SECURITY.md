# Security Guide

## Authentication & sessions

- **Firebase Authentication** (optional) + local bcrypt login — one login page,
  role routing server-side.
- Internal RBAC (`owner / admin / staff / customer`) is stored in NIMBUS, never as
  a client-side claim.
- Sessions are signed JWTs in httpOnly, SameSite=Lax cookies (Secure in production)
  with 7-day expiry; logout clears the session.
- Login history, device sessions and account risk alerts (suspicious patterns) are
  recorded per user.

## Transport & headers

nginx terminates TLS (Let's Encrypt). The API sets `Strict-Transport-Security`,
`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` and
`Permissions-Policy`. WebSockets are authorized per connection and per message.

## Isolation

- Docker API never exposed; the agent executes a **fixed whitelist** of operations.
- Customers never execute shell commands on the control plane.
- Containers: `no-new-privileges`, CPU/RAM caps, per-service data roots.
- VPS/VDS use real virtualization (KVM/libvirt/Proxmox) — never containers.
- Long-running work runs in job queues, not request handlers.

## Data protection

- Passwords: bcrypt (cost 12). Secrets: environment-only, `600` permissions.
- OAuth refresh tokens (Google Drive): AES-256-GCM encrypted at rest.
- Firebase credentials never reach the browser.
- Audit log (append-only) records logins, lifecycle actions, allocation and domain
  changes, backups and restores.

## Input & abuse

- class-validator whitelisting on every DTO (`forbidNonWhitelisted`).
- Rate limiting on all routes; stricter on auth.
- Path-traversal guards in the node agent's file/backup handlers.
- Domain ownership verification (TXT) prevents takeover; uniqueness prevents
  duplicate assignment.
- SSRF protection: outbound integrations use fixed hosts (Cloudflare, Google APIs).
- Upload validation and backup access control on every restore path.

## Reporting

See [SECURITY.md](../SECURITY.md). Do not open public issues for vulnerabilities.
