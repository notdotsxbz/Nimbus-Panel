# Troubleshooting

## Service not starting

1. Admin → **All Services** — check the status badge (Error vs Starting).
2. Open the service **Console** for the crash output.
3. Node in maintenance mode? Admin → Nodes. Disk full on the node? Check node metrics.
4. After a failed start the service reverts to its previous state automatically —
   the recovery engine caps restart retries to prevent loops.

## Node offline

1. Can you SSH to the node? Is Docker running (`systemctl status docker`)?
2. `systemctl status nimbus-agent` on the node; inspect `journalctl -u nimbus-agent`.
3. Firewall must allow the panel → node `7443/tcp`.
4. After fixing, the next heartbeat (≤15 s) flips the node online.

## DNS error (domain not resolving)

1. `dig TXT _nimbus.<domain>` — is the verification record present?
2. Wildcard record for the hosting domain pointing at the correct node IP.
3. DNS TTL propagation can take up to the record TTL (default 3600 s).

## SSL error

Certbot logs: `/var/log/letsencrypt/letsencrypt.log`. Domain must point at the
panel before issuance. Raw TCP game traffic is never covered by HTTPS certs.

## Port unavailable

Allocations are unique per node+IP+port+protocol. Admin → Allocations shows what's
taken; auto-allocation picks the next free port in range (4001–4050 default).

## Backup failure

1. Check the backup row's error field in Admin → Backups.
2. Google Drive: re-connect the account (token can be revoked by the user).
3. Check node disk space — snapshots need temporary headroom.

## Login issue

1. Wrong credentials → the audit log records failures; try password reset by an admin.
2. Rate limited? Wait 60 s (login is limited to 10/min).
3. Suspended account → admin reactivates under Users.

## Deployment failure

Check build logs on the service; secrets are never printed. Common causes: wrong
start command, missing environment variables, build OOM (raise RAM).

## Storage full

Free node space or raise capacity, then run a manual backup + reinstall of the
affected service after snapshotting.

## Minecraft crash

Console shows the Java stack trace. Typical: insufficient RAM, plugin/version
mismatch, corrupted region file (restore a backup).
