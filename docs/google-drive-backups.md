# Google Drive Backups

## Google Cloud OAuth setup

Create an OAuth 2.0 Client ID with application type **Web application**. Enable the Google Drive API in the same Google Cloud project.

Use the panel origin as an Authorized JavaScript origin (no path and no trailing slash):

```text
https://your-panel.example.com
```

Add both callback URLs as Authorized redirect URIs:

```text
https://your-panel.example.com/admin/settings
https://your-panel.example.com/account
```

The Admin callback is used for the separate Admin Drive. The Account callback is used for each customer's personal Drive. Do not put either callback path in the Authorized JavaScript origins field.

Google OAuth requests OpenID/email identity plus the `drive.file` scope. Nimbus stores the OAuth refresh token encrypted on the API server. Customer refresh tokens are stored separately by customer ID; the Admin token is stored separately from all customer tokens.

## Connecting accounts

1. An authorized panel owner/admin opens Admin Settings → Integrations → Google Drive and configures the OAuth Client ID and Client Secret.
2. The Admin authorizes the Admin Google account separately. This Drive is reserved for panel-level/admin backups.
3. Each customer opens Account Settings → Personal Google Drive and authorizes their own Google account.
4. Customer service backups are sent to that customer's Drive. Admin-created service backups are sent to the Admin Drive and organized by customer ID/name.

Disconnecting a Drive removes only that account's saved Nimbus authorization. It does not delete files already stored in Google Drive.

## Encryption and recovery

Drive backup archives are encrypted with AES-256-GCM before upload. The API stores the IV, authentication tag, algorithm and key version alongside the backup record. The encryption key is derived from the server's `INTEGRATION_ENCRYPTION_KEY`; keep this secret backed up securely and do not rotate it without a migration plan. If this key is lost, encrypted archives cannot be decrypted.

OAuth refresh tokens are also encrypted at rest using the panel integration encryption key. Never place the key, OAuth client secret, refresh tokens or access tokens in Git, support tickets or frontend code.

## Current service support

Service backups use the existing Node Agent's service data directory. Only service types that are actually provisioned and backed by this storage path can be backed up this way. VPS/VDS full-disk snapshots are not supported until a virtualization provider and VM-aware Node Agent are installed; the panel must not label file-only backups as full VM backups.

Per-service schedules, retention and customer service restore are implemented for the current Node Agent service-data path. Large-file resumable streaming, panel database/full-panel backup and selected-customer restore workflows remain under development until the associated implementation and tests are complete.