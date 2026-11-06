# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security vulnerabilities.
Email `security@nimbushost.com` (or use a private GitHub security advisory)
with steps to reproduce, affected versions and impact assessment.
You will receive an acknowledgement within 72 hours.

## Hardening requirements for production installs

1. Change the bootstrap administrator credentials on first login (enforced).
2. Serve the panel behind HTTPS only (installer configures Let's Encrypt or
   your own certificate; HTTP is redirected).
3. Never expose MongoDB, Redis or the Docker daemon publicly. Bind them to
   localhost or a private network.
4. Node enrollment tokens are single-use and expire in 30 minutes.
5. Node agents authenticate with per-node credentials issued at enrollment;
   revoke them from *Admin → Nodes* before removing a node.
6. Cloudflare integration uses a scoped API token (DNS edit only) — never an
   account-wide key, and never account passwords.
7. Google Drive OAuth refresh tokens are encrypted at rest with
   `BACKUP_TOKEN_ENCRYPTION_KEY`.
8. All sensitive operations (logins, service lifecycle, allocation changes,
   domain changes, backups) are written to the immutable `AuditLogs` collection.
