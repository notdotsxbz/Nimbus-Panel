# NIMBUS Google Drive Backups

## Google Cloud OAuth setup

1. Create or select a Google Cloud project for NIMBUS.
2. Enable the **Google Drive API**.
3. Configure the OAuth consent screen / Google Auth Platform branding and add the required support and developer contact details.
4. Create an OAuth 2.0 client with application type **Web application**.
5. Add this authorized JavaScript origin:

   `https://YOUR-PANEL-DOMAIN`

6. Add both authorized redirect URIs:

   `https://YOUR-PANEL-DOMAIN/admin/settings`

   `https://YOUR-PANEL-DOMAIN/dashboard/backups`

7. Save the OAuth Client ID and Client Secret in **Admin → Settings → Google Drive**. The secret is stored server-side and is not sent to customer browsers.
8. If the consent screen is in Testing mode, add the accounts that need to connect as test users.

Customers then connect their own Google accounts from **Dashboard → Backups**. Admin Google Drive and customer Google Drives use separate encrypted refresh-token records.

## Backup encryption key

NIMBUS uses `BACKUP_ENCRYPTION_KEY` (64 hexadecimal characters) for AES-256-GCM backup archive encryption. New installations and upgrades generate it if it is missing.

**Keep an offline recovery copy of this key in a secure location separate from the VPS and Google Drive backups.** Losing the key means the encrypted archives cannot be decrypted. Never paste the key into support chats, issues, or logs.

Check whether the key is configured without displaying its value:

```bash
sudo grep -qE '^BACKUP_ENCRYPTION_KEY=[a-fA-F0-9]{64}$' /opt/nimbus/.env \
  && echo "Backup encryption key configured" \
  || echo "Backup encryption key missing or invalid"
```

## Customer backups

- Customers connect their own Google Drive account.
- Each service backup is encrypted before upload and stored under the customer's `NIMBUS Backups` folder.
- Backup downloads and restores verify the archive checksum.
- Automatic schedules are configured per service. Daily and weekly times use UTC.
- Retention can keep the latest 5, 10, or 30 backups, retain by days, or never automatically delete.
- Disconnecting Google Drive does not delete files already stored in Drive.

## Admin backups

- Admin Google Drive is independent from customer Drive accounts.
- Full panel backup jobs include a MongoDB dump, encrypted `.env` snapshot, infrastructure metadata, customer-wise service archives, and a manifest.
- Selected customer and selected service backup jobs are also available.
- Full-panel backups are best-effort sequential snapshots, not globally quiesced point-in-time snapshots.
- Full VM/disk snapshots for VPS/VDS are not supported by the current Node Agent and are reported as excluded/partial.

## Full panel restore

1. In **Admin → Backups**, choose a completed full panel backup and select **Prepare restore package**.
2. NIMBUS downloads and verifies the encrypted database, environment, and system-metadata artifacts into `/opt/nimbus/var/restore-staging/<backup-id>`.
3. Schedule a maintenance window. Review the staged manifest and exclusions.
4. Run the exact command shown by the panel over SSH. The restore script requires the phrase `RESTORE FULL NIMBUS PANEL`, creates a safety dump of the current database and a copy of the current `.env`, then restores the panel database/configuration.
5. After the panel restarts, use the Admin Backups page to restore the customer service archives from the restored backup records.

The restore script does not automatically restore remote customer service files or VM disk images. Service archives are restored separately so each service can be verified and handled with explicit confirmation.

## Operational notes

- Large archives are streamed and uploaded with resumable Drive uploads.
- A failed Drive upload preserves the source archive on the node so it can be retried.
- Drive quota exhaustion or API rate limits can cause a backup job to fail; review the job status and retry after resolving the Drive issue.
- Test restore procedures on a disposable environment before relying on backups for production recovery.
