# Backup Guide

## Layers

1. **Control plane** — `installer/backup.sh` dumps the MongoDB database + `.env`
   (sha256-verified). Run via cron nightly.
2. **Per-service snapshots** — created by the node agent (tar + sha256 checksum),
   stored locally, Google Drive or S3-compatible storage.

## Google Drive (per account)

Both administrators and customers connect their **own** Drive:

1. Backups → **Connect Google Drive** (OAuth consent — `drive.file` scope only).
2. Choose destination folder.
3. Enable daily/weekly/custom schedules with timezone-aware timing.
4. Refresh tokens are encrypted at rest (`BACKUP_TOKEN_ENCRYPTION_KEY`).

Large backups use resumable uploads; every upload ends with checksum verification.

## Snapshots

- Manual, scheduled, **pre-update** and **pre-reinstall** snapshots
- Every snapshot records size, checksum, trigger and history

## Restore

Restores are **staged**: the agent extracts into a staging directory, the checksum
is verified, and only then is the service data swapped — a failed restore never
destroys existing data. Restore history is kept in the audit log.

## Integrity

Verify a control-plane backup: `sha256sum -c <archive>.sha256`.
Snapshot verification runs automatically before any restore.
