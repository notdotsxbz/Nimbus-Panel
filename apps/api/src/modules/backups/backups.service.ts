import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import axios from "axios";
import { AuditService } from "../audit/audit.service";
import { Backup, BackupDocument, BackupSchedule, BackupScheduleDocument, BackupJob, BackupJobDocument } from "./backup.schema";
import { NodesService } from "../nodes/nodes.service";
import { ServicesService } from "../services/services.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { env } from "../../config/env";
import { NotificationsService } from "../notifications/notifications.service";

const execFileAsync = promisify(execFile);

/**
 * Backup orchestration. Heavy lifting (tar + integrity) happens on the node
 * agent; upload goes directly to Google Drive / S3 using encrypted OAuth
 * refresh tokens stored here. Restore never silently overwrites data — the
 * agent extracts to a staging directory first and the API records the restore.
 */
@Injectable()
export class BackupsService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @InjectModel(Backup.name) private readonly backups: Model<BackupDocument>,
    @InjectModel(BackupSchedule.name) private readonly schedules: Model<BackupScheduleDocument>,
    @InjectModel(BackupJob.name) private readonly jobs: Model<BackupJobDocument>,
    private readonly nodes: NodesService,
    private readonly services: ServicesService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
    private readonly notifications: NotificationsService,
  ) {}

  private scheduleTimer?: NodeJS.Timeout;
  private backupJobTimer?: NodeJS.Timeout;
  private scheduleWorkerRunning = false;
  private backupJobWorkerRunning = false;

  onModuleInit() {
    this.scheduleTimer = setInterval(() => { void this.runScheduledBackups(); }, 30_000);
    this.scheduleTimer.unref?.();
    this.backupJobTimer = setInterval(() => { void this.runBackupJobs(); }, 10_000);
    this.backupJobTimer.unref?.();
    void this.runScheduledBackups();
    void this.runBackupJobs();
  }

  onModuleDestroy() {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.backupJobTimer) clearInterval(this.backupJobTimer);
  }

  private nextScheduleRun(frequency: string, time: string, from = new Date()): Date | undefined {
    if (frequency === "manual") return undefined;
    if (frequency === "every6h") return new Date(from.getTime() + 6 * 60 * 60 * 1000);
    if (frequency === "every12h") return new Date(from.getTime() + 12 * 60 * 60 * 1000);
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    const hour = match ? Number(match[1]) : 2;
    const minute = match ? Number(match[2]) : 0;
    const next = new Date(from);
    next.setUTCHours(hour, minute, 0, 0);
    if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + (frequency === "weekly" ? 7 : 1));
    return next;
  }

  async getSchedule(serviceId: string, user: { id: string; role: string }) {
    const service = await this.services.get(serviceId, user as never);
    const schedule = await this.schedules.findOne({ serviceId: service._id });
    return schedule ?? {
      serviceId: service._id,
      ownerId: service.ownerId,
      enabled: false,
      frequency: "manual",
      time: "02:00",
      retention: 5,
      notifyOnCompletion: true,
      nextRunAt: null,
      lastRunAt: null,
    };
  }

  async saveSchedule(dto: {
    serviceId: string; enabled?: boolean; frequency?: string; time?: string;
    retention?: number; notifyOnCompletion?: boolean;
  }, user: { id: string; role: string }) {
    const service = await this.services.get(dto.serviceId, user as never);
    const frequency = dto.frequency ?? "manual";
    if (!["manual", "every6h", "every12h", "daily", "weekly"].includes(frequency)) {
      throw new BadRequestException("Invalid backup frequency");
    }
    const time = dto.time ?? "02:00";
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BadRequestException("Backup time must be in 24-hour HH:mm format (UTC)");
    const retention = dto.retention ?? 5;
    if (![0, 5, 10, 30].includes(retention)) throw new BadRequestException("Retention must be 5, 10, 30 or 0 for never delete");
    const enabled = dto.enabled === true && frequency !== "manual";
    const nextRunAt = enabled ? this.nextScheduleRun(frequency, time) : undefined;
    const schedule = await this.schedules.findOneAndUpdate(
      { serviceId: service._id },
      {
        $set: {
          ownerId: service.ownerId,
          enabled,
          frequency,
          time,
          retention,
          notifyOnCompletion: dto.notifyOnCompletion !== false,
          nextRunAt: nextRunAt ?? null,
          leaseUntil: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await this.audit.log({
      actorId: user.id,
      action: "backups.schedule.update",
      targetType: "service",
      targetId: service._id!.toString(),
      detail: `enabled=${enabled} frequency=${frequency} retention=${retention}`,
      sensitive: true,
    });
    return schedule;
  }

  private async runScheduledBackups() {
    if (this.scheduleWorkerRunning) return;
    this.scheduleWorkerRunning = true;
    try {
      const now = new Date();
      const due = await this.schedules.find({ enabled: true, nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 }).limit(10);
      for (const candidate of due) {
        const nextRunAt = this.nextScheduleRun(candidate.frequency, candidate.time, now);
        const claimed = await this.schedules.findOneAndUpdate(
          {
            _id: candidate._id,
            enabled: true,
            nextRunAt: { $lte: now },
            $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lt: now } }],
          },
          { $set: { leaseUntil: new Date(now.getTime() + 30 * 60 * 1000), lastRunAt: now, nextRunAt: nextRunAt ?? null } },
          { new: true },
        );
        if (!claimed) continue;
        const owner = { id: claimed.ownerId.toString(), role: "customer" };
        try {
          const result = await this.create(claimed.serviceId.toString(), owner, "scheduled", "gdrive");
          if (result.status === "completed") {
            if (claimed.notifyOnCompletion) await this.notifications.notify(owner.id, "backup", "Scheduled backup completed", "A scheduled backup for your service has completed and was verified.");
            await this.applyScheduleRetention(claimed, owner);
          } else if (claimed.notifyOnCompletion) {
            await this.notifications.notify(owner.id, "backup", "Scheduled backup failed", result.error || "The scheduled backup could not be completed. Check your Google Drive connection.");
          }
        } catch (error) {
          if (claimed.notifyOnCompletion) await this.notifications.notify(owner.id, "backup", "Scheduled backup failed", error instanceof Error ? error.message : "The scheduled backup failed.");
        } finally {
          await this.schedules.updateOne({ _id: claimed._id }, { $set: { leaseUntil: null } });
        }
      }
    } catch (error) {
      console.error("[backup-scheduler] worker failed:", error instanceof Error ? error.message : "unknown error");
    } finally {
      this.scheduleWorkerRunning = false;
    }
  }

  private async applyScheduleRetention(schedule: BackupScheduleDocument, user: { id: string; role: string }) {
    if (!schedule.retention || schedule.retention <= 0) return;
    const completed = await this.backups.find({ serviceId: schedule.serviceId, status: "completed" }).sort({ createdAt: -1 }).select("_id").lean();
    for (const old of completed.slice(schedule.retention)) {
      try { await this.delete(String(old._id), user); }
      catch (error) { console.error("[backup-retention] could not delete expired backup:", error instanceof Error ? error.message : "unknown error"); }
    }
  }

  async adminBackupSummary(user: { id: string; role: string }) {
    if (!["owner", "admin"].includes(user.role)) throw new BadRequestException("Admin permission required");
    const services = await this.services.listFor(user as never, {}, 1000);
    const [customerCount, nodeCount] = await Promise.all([
      this.backups.db.collection("users").countDocuments({ role: "customer", deletedAt: { $exists: false }, suspended: { $ne: true } }),
      this.backups.db.collection("nodes").countDocuments(),
    ]);
    return {
      customerCount,
      serviceCount: services.length,
      nodeCount,
      estimatedBackupSizeBytes: null,
      included: ["Panel MongoDB database dump", "Encrypted panel configuration and system metadata", "Eligible customer service archives", "Full backup manifest"],
      excluded: ["VPS/VDS full-disk images (not supported by the current Docker-only agent)"],
    };
  }

  async enqueueBackupJob(
    serviceIds: string[],
    user: { id: string; role: string },
    trigger = "manual",
    destination = "gdrive",
  ) {
    if (!serviceIds.length || serviceIds.length > 1000) throw new BadRequestException("Select between 1 and 1000 services");
    if (destination !== "gdrive") throw new BadRequestException("User-requested backups must be stored in Google Drive");
    if (!["manual", "scheduled", "pre-update", "pre-reinstall", "pre-restore"].includes(trigger)) throw new BadRequestException("Invalid backup trigger");
    const driveStatus = user.role === "customer"
      ? await this.integrations.googleDriveStatus("customer", user.id)
      : await this.integrations.googleDriveStatus("admin");
    if (!driveStatus.connected) throw new BadRequestException("Connect the correct Google Drive account before starting backups");
    const uniqueIds = [...new Set(serviceIds)];
    const requested = new Set(uniqueIds);
    const available = await this.services.listFor(user as never, {}, 1000);
    const services = available.filter((service) => requested.has(service._id!.toString()));
    if (services.length !== uniqueIds.length) throw new BadRequestException("One or more selected services were not found or are not owned by this account");
    const ownerType = user.role === "customer" ? "customer" : "admin";
    const job = await this.jobs.create({
      requestedBy: new Types.ObjectId(user.id),
      ownerId: new Types.ObjectId(user.id),
      ownerType,
      requesterRole: user.role,
      serviceIds: services.map((service) => service._id!),
      trigger,
      destination,
      status: "queued",
      total: services.length,
      completed: 0,
      failed: 0,
      results: [],
    });
    return { jobId: job._id!.toString(), status: job.status, total: job.total };
  }

  async listJobs(user: { id: string; role: string }) {
    const filter = user.role === "customer" ? { ownerId: new Types.ObjectId(user.id) } : {};
    return this.jobs.find(filter).sort({ createdAt: -1 }).limit(50);
  }

  async getJob(jobId: string, user: { id: string; role: string }) {
    const filter: Record<string, unknown> = { _id: jobId };
    if (user.role === "customer") filter.ownerId = new Types.ObjectId(user.id);
    const job = await this.jobs.findOne(filter);
    if (!job) throw new NotFoundException("Backup job not found");
    return job;
  }

  private async createPanelDatabaseArtifact(jobId: string) {
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-panel-db-"));
    try {
      const configPath = join(tempDir, "mongodump.yml");
      const archivePath = join(tempDir, "nimbus-database.archive.gz.enc");
      // The MongoDB URI is written only to a mode-0600 temporary config file,
      // never passed as a process argument or written to logs.
      await writeFile(configPath, "uri: " + JSON.stringify(env.mongoUri) + "\n", { mode: 0o600 });
      await execFileAsync("mongodump", ["--config", configPath, "--db", "nimbus", "--archive=" + archivePath, "--gzip"], {
        timeout: 4 * 60 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return this.uploadPanelArtifactFile(archivePath, "nimbus-database-" + jobId + ".archive.gz.enc", "Database", jobId, "database");
    } catch (error) {
      const message = error instanceof Error ? error.message : "mongodump failed";
      if (message.includes("ENOENT") || message.includes("not found")) {
        throw new BadRequestException("mongodump is not installed on the panel server. Install MongoDB Database Tools before running a Full Panel Backup.");
      }
      throw new BadRequestException("Panel database backup failed: " + message.slice(0, 500));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async createPanelConfigurationArtifact(jobId: string) {
    const config = {
      createdAt: new Date().toISOString(),
      panel: "NIMBUS",
      nodeVersion: process.version,
      environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "INTEGRATION_ENCRYPTION_KEY")),
      encryptionKeyRecovery: "Supply INTEGRATION_ENCRYPTION_KEY from the operator's separate secure escrow during recovery.",
    };
    const archive = Buffer.from(JSON.stringify(config, null, 2), "utf8");
    return this.uploadPanelArtifact(archive, "nimbus-configuration-" + jobId + ".json.enc", "Configuration", jobId, "configuration");
  }

  private async createPanelSystemMetadataArtifact(jobId: string) {
    const metadata = {
      createdAt: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      appVersion: process.env.npm_package_version ?? "unknown",
      panelDomain: env.panelDomain,
      hostingDomain: env.hostingDomain,
      databaseName: "nimbus",
    };
    return this.uploadPanelArtifact(
      Buffer.from(JSON.stringify(metadata, null, 2), "utf8"),
      "nimbus-system-metadata-" + jobId + ".json.enc",
      "System Metadata",
      jobId,
      "system-metadata",
    );
  }

  private async uploadPanelArtifactFile(
    sourcePath: string,
    filename: string,
    folder: "Database" | "Configuration" | "System Metadata" | "Full Backup Manifests",
    jobId: string,
    artifactType: string,
  ) {
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-panel-artifact-"));
    try {
      const encryptedPath = join(tempDir, "artifact.enc");
      const [sourceStat, checksum, folderId, accessToken] = await Promise.all([
        stat(sourcePath),
        this.hashFile(sourcePath, "hex"),
        this.integrations.googleDriveAdminPanelFolder(folder),
        this.integrations.googleDriveAccessToken("admin"),
      ]);
      const encryptionMetadata = await this.encryptArchiveFile(sourcePath, encryptedPath);
      const encryptedStat = await stat(encryptedPath);
      const metadata = {
        name: filename,
        mimeType: "application/octet-stream",
        parents: [folderId],
        appProperties: {
          nimbusPanelBackupId: jobId,
          nimbusArtifactType: artifactType,
          nimbusSha256: checksum,
          nimbusIv: encryptionMetadata.iv,
          nimbusTag: encryptionMetadata.authTag,
          nimbusKeyVersion: encryptionMetadata.keyVersion,
          nimbusAlgorithm: encryptionMetadata.algorithm,
        },
      };
      const fileId = await this.uploadResumableDriveFile(accessToken, metadata, encryptedPath, encryptedStat.size);
      const downloaded = await axios.get(
        "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media",
        { headers: { authorization: "Bearer " + accessToken }, responseType: "stream", timeout: 60 * 60 * 1000 },
      );
      const actualHash = createHash("sha256");
      for await (const chunk of downloaded.data as Readable) actualHash.update(chunk as Buffer);
      const expectedHash = await this.hashFile(encryptedPath, "hex");
      if (actualHash.digest("hex") !== expectedHash) {
        await axios.delete("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId), {
          headers: { authorization: "Bearer " + accessToken },
        }).catch(() => undefined);
        throw new BadRequestException("Admin panel artifact upload verification failed");
      }
      return {
        fileId,
        filename,
        folderId,
        checksum,
        sizeBytes: sourceStat.size,
        encryptionMetadata,
        verificationStatus: "verified",
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async uploadPanelArtifact(
    plaintext: Buffer,
    filename: string,
    folder: "Database" | "Configuration" | "System Metadata" | "Full Backup Manifests",
    jobId: string,
    artifactType: string,
  ) {
    const accessToken = await this.integrations.googleDriveAccessToken("admin");
    const folderId = await this.integrations.googleDriveAdminPanelFolder(folder);
    const checksum = createHash("sha256").update(plaintext).digest("hex");
    const encrypted = this.encryptArchive(plaintext);
    const metadata = {
      name: filename,
      mimeType: "application/octet-stream",
      parents: [folderId],
      appProperties: {
        nimbusPanelBackupId: jobId,
        nimbusArtifactType: artifactType,
        nimbusSha256: checksum,
        nimbusIv: encrypted.metadata.iv,
        nimbusTag: encrypted.metadata.authTag,
        nimbusKeyVersion: encrypted.metadata.keyVersion,
        nimbusAlgorithm: encrypted.metadata.algorithm,
      },
    };
    const fileId = await this.uploadResumableDriveUpload(accessToken, metadata, encrypted.data);
    const downloaded = await axios.get(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media",
      { headers: { authorization: "Bearer " + accessToken }, responseType: "arraybuffer", maxContentLength: Infinity, timeout: 60 * 60 * 1000 },
    );
    const downloadedDigest = createHash("sha256").update(Buffer.from(downloaded.data)).digest("hex");
    const uploadedDigest = createHash("sha256").update(encrypted.data).digest("hex");
    if (downloadedDigest !== uploadedDigest) {
      await axios.delete("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId), {
        headers: { authorization: "Bearer " + accessToken },
      }).catch(() => undefined);
      throw new BadRequestException("Admin panel artifact upload verification failed");
    }
    return {
      fileId,
      filename,
      folderId,
      checksum,
      sizeBytes: plaintext.length,
      encryptionMetadata: encrypted.metadata,
      verificationStatus: "verified",
    };
  }

  private async createFullPanelManifest(job: BackupJobDocument) {
    const backupIds = (job.results ?? []).map((result) => result.backupId).filter((id): id is string => Boolean(id));
    const records = backupIds.length
      ? await this.backups.find({ _id: { $in: backupIds.map((id) => new Types.ObjectId(id)) } }).populate("serviceId", "name type").lean()
      : [];
    const ownerIds = [...new Set(records.map((record) => record.ownerId.toString()))].map((id) => new Types.ObjectId(id));
    const users = ownerIds.length
      ? await this.backups.db.collection("users").find({ _id: { $in: ownerIds } }).project({ displayName: 1, username: 1, email: 1 }).toArray()
      : [];
    const userNames = new Map<string, string>(users.map((user: any): [string, string] => [String(user._id), String(user.displayName || user.username || user.email || user._id)]));
    const customers = new Map<string, { customerId: string; customerName: string; services: Array<Record<string, unknown>> }>();
    for (const record of records as any[]) {
      const customerId = record.ownerId.toString();
      const customer: { customerId: string; customerName: string; services: Array<Record<string, unknown>> } = customers.get(customerId) ?? {
        customerId,
        customerName: userNames.get(customerId) ?? customerId,
        services: [],
      };
      const service = record.serviceId as { _id?: Types.ObjectId; name?: string; type?: string };
      customer.services.push({
        serviceId: service?._id?.toString(),
        serviceName: service?.name ?? "Unknown service",
        serviceType: service?.type ?? "unknown",
        backupId: record._id.toString(),
        driveFileId: record.remoteFileId,
        driveOwnerType: record.driveOwnerType ?? "admin",
        driveOwnerId: record.driveOwnerId?.toString() ?? null,
        destination: record.destination,
        trigger: record.trigger,
        backupName: record.backupName,
        backupType: record.backupType,
        encryptionMetadata: record.encryptionMetadata,
        checksum: record.checksum,
        sizeBytes: record.sizeBytes,
        verificationStatus: record.verificationStatus,
        createdAt: record.createdAt,
      });
      customers.set(customerId, customer);
    }
    const manifest = {
      schemaVersion: 1,
      backupJobId: job._id!.toString(),
      createdAt: job.createdAt,
      panelArtifacts: job.panelArtifacts ?? {},
      customers: [...customers.values()],
      serviceBackupResults: job.results,
      totals: { services: job.total - 4, completed: job.completed, failed: job.failed },
    };
    const buffer = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    return this.uploadPanelArtifact(buffer, "nimbus-full-panel-manifest-" + job._id!.toString() + ".json.enc", "Full Backup Manifests", job._id!.toString(), "manifest");
  }

  private async runBackupJobs() {
    if (this.backupJobWorkerRunning) return;
    this.backupJobWorkerRunning = true;
    try {
      const now = new Date();
      const job = await this.jobs.findOneAndUpdate(
        { $or: [{ status: "queued" }, { status: "running", leaseUntil: { $lt: now } }] },
        { $set: { status: "running", leaseUntil: new Date(now.getTime() + 8 * 60 * 60 * 1000), startedAt: now } },
        { sort: { createdAt: 1 }, new: true },
      );
      if (!job) return;
      const user = { id: job.requestedBy.toString(), role: job.requesterRole };

      if (job.mode === "restore-batch") {
        await this.processRestoreJob(job, user);
        return;
      }

      if (job.mode === "full-panel") {
        const artifactTasks: Array<[string, () => Promise<Record<string, unknown>>]> = [
          ["database", () => this.createPanelDatabaseArtifact(job._id!.toString())],
          ["configuration", () => this.createPanelConfigurationArtifact(job._id!.toString())],
          ["systemMetadata", () => this.createPanelSystemMetadataArtifact(job._id!.toString())],
        ];
        for (const [key, createArtifact] of artifactTasks) {
          if (job.panelArtifacts?.[key]) continue;
          job.leaseUntil = new Date(Date.now() + 8 * 60 * 60 * 1000);
          await job.save();
          try {
            const artifact = await createArtifact();
            job.panelArtifacts = { ...(job.panelArtifacts ?? {}), [key]: artifact };
            job.completed += 1;
          } catch (error) {
            job.failed += 1;
            job.results.push({
              serviceId: "panel-" + key,
              status: "failed",
              error: error instanceof Error ? error.message : "Panel artifact backup failed",
            });
          }
          await job.save();
        }
      }

      const completedServiceIds = new Set((job.results ?? []).map((result) => result.serviceId));
      for (const serviceObjectId of job.serviceIds) {
        const serviceId = serviceObjectId.toString();
        if (completedServiceIds.has(serviceId)) continue;
        job.currentServiceId = serviceObjectId;
        job.leaseUntil = new Date(Date.now() + 8 * 60 * 60 * 1000);
        await job.save();
        try {
          const backup = await this.create(serviceId, user, job.trigger, job.destination, false, job._id!.toString());
          job.results.push({
            serviceId,
            status: backup.status,
            backupId: backup._id!.toString(),
            ...(backup.error ? { error: backup.error } : {}),
          });
          if (backup.status === "completed") job.completed += 1;
          else job.failed += 1;
        } catch (error) {
          job.results.push({ serviceId, status: "failed", error: error instanceof Error ? error.message : "Backup failed" });
          job.failed += 1;
        }
        await job.save();
      }

      if (job.mode === "full-panel" && !job.panelArtifacts?.manifest) {
        try {
          const manifest = await this.createFullPanelManifest(job);
          job.panelArtifacts = { ...(job.panelArtifacts ?? {}), manifest };
          job.completed += 1;
        } catch (error) {
          job.failed += 1;
          job.results.push({
            serviceId: "panel-manifest",
            status: "failed",
            error: error instanceof Error ? error.message : "Full panel manifest creation failed",
          });
        }
        await job.save();
      }

      job.status = job.mode === "full-panel"
        ? (job.failed === 0 ? "completed" : "failed")
        : (job.failed === job.total ? "failed" : "completed");
      job.currentServiceId = undefined;
      job.leaseUntil = undefined;
      job.completedAt = new Date();
      await job.save();
      await this.notifications.notify(
        job.requestedBy.toString(),
        "backup",
        job.status === "completed" ? "Backup job completed" : "Backup job failed",
        job.completed + " of " + job.total + " backup tasks completed; " + job.failed + " failed.",
      );
      await this.audit.log({
        actorId: job.requestedBy.toString(),
        action: job.mode === "full-panel" ? "backups.full-panel.completed" : "backups.job.completed",
        targetType: "backup-job",
        targetId: job._id!.toString(),
        detail: "mode=" + job.mode + " total=" + job.total + " completed=" + job.completed + " failed=" + job.failed,
        sensitive: true,
      });
    } catch (error) {
      console.error("[backup-job-worker] worker failed:", error instanceof Error ? error.message : "unknown error");
    } finally {
      this.backupJobWorkerRunning = false;
    }
  }

  private async downloadAdminPanelArtifact(
    artifact: { fileId: string; checksum: string; encryptionMetadata: { algorithm: string; iv: string; authTag: string; keyVersion: string } },
    destinationPath: string,
  ) {
    const accessToken = await this.integrations.googleDriveAccessToken("admin");
    const encryptedPath = destinationPath + ".enc";
    const response = await axios.get(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(artifact.fileId) + "?alt=media",
      { headers: { authorization: "Bearer " + accessToken }, responseType: "stream", timeout: 60 * 60 * 1000 },
    );
    await pipeline(response.data, createWriteStream(encryptedPath, { mode: 0o600 }));
    try {
      await this.decryptArchiveFile(encryptedPath, destinationPath, artifact.encryptionMetadata);
      if (await this.hashFile(destinationPath, "hex") !== artifact.checksum) {
        throw new BadRequestException("Full Panel Backup artifact checksum verification failed");
      }
    } finally {
      await rm(encryptedPath, { force: true });
    }
  }

  async prepareFullPanelRestore(jobId: string, user: { id: string; role: string }, confirmed: boolean) {
    if (!["owner", "admin"].includes(user.role)) throw new BadRequestException("Admin permission required");
    if (confirmed !== true) throw new BadRequestException("Explicit confirmation is required before preparing panel recovery");
    const job = await this.jobs.findById(jobId);
    if (!job || job.mode !== "full-panel") {
      throw new BadRequestException("Select a Full Panel Backup job");
    }
    const artifacts = job.panelArtifacts ?? {};
    type PanelArtifactRef = { fileId: string; checksum: string; encryptionMetadata: { algorithm: string; iv: string; authTag: string; keyVersion: string } };
    const database = artifacts.database as PanelArtifactRef | undefined;
    const configuration = artifacts.configuration as PanelArtifactRef | undefined;
    const manifest = artifacts.manifest as PanelArtifactRef | undefined;
    if (!database?.fileId || !database.checksum || !database.encryptionMetadata || !configuration?.fileId || !configuration.checksum || !configuration.encryptionMetadata) {
      throw new BadRequestException("The Full Panel Backup is missing its database or configuration artifact");
    }
    const stagingRoot = join(process.cwd(), "restore-staging");
    const stagingDir = join(stagingRoot, jobId);
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    await chmod(stagingRoot, 0o700).catch(() => undefined);
    await chmod(stagingDir, 0o700);
    const databasePath = join(stagingDir, "database.archive.gz");
    const configPath = join(stagingDir, "configuration.json");
    await this.downloadAdminPanelArtifact(database, databasePath);
    await this.downloadAdminPanelArtifact(configuration, configPath);
    if (!manifest?.fileId || !manifest.checksum || !manifest.encryptionMetadata) {
      throw new BadRequestException("The Full Panel Backup is missing its recovery manifest");
    }
    const manifestPath = join(stagingDir, "manifest.json");
    await this.downloadAdminPanelArtifact(manifest, manifestPath);
    const panelRoot = process.cwd();
    const script = [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      "umask 077",
      `PANEL_ROOT=${JSON.stringify(panelRoot)}`,
      'STAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'if [[ "$EUID" -ne 0 ]]; then echo "Run this recovery script with sudo."; exit 1; fi',
      'if [[ ! -f "$PANEL_ROOT/.env" ]]; then echo "Current panel .env file not found."; exit 1; fi',
      'cd "$PANEL_ROOT"',
      'CURRENT_MONGODB_URI="$(node - "$PANEL_ROOT/.env" <<\'NODE\'',
      'const fs = require("fs"); const dotenv = require("dotenv"); const parsed = dotenv.parse(fs.readFileSync(process.argv[2])); process.stdout.write(parsed.MONGODB_URI || "");',
      'NODE',
      ')"',
      'if [[ -z "$CURRENT_MONGODB_URI" ]]; then echo "Current MONGODB_URI is missing from .env."; exit 1; fi',
      'SAFETY_DIR="/var/backups/nimbus/full-restore-$(date +%Y%m%d-%H%M%S)"',
      'mkdir -p "$SAFETY_DIR"',
      'chmod 700 "$SAFETY_DIR"',
      'cp -a "$PANEL_ROOT/.env" "$SAFETY_DIR/.env.before"',
      'mongodump --uri="$CURRENT_MONGODB_URI" --db nimbus --archive="$SAFETY_DIR/database.before.archive.gz" --gzip',
      'read -r -s -p "Enter INTEGRATION_ENCRYPTION_KEY from your separate secure escrow: " NIMBUS_RECOVERY_KEY; echo',
      'if [[ -z "$NIMBUS_RECOVERY_KEY" ]]; then echo "Encryption key is required."; exit 1; fi',
      'node - "$STAGING_DIR/configuration.json" "$STAGING_DIR/restore.env" "$NIMBUS_RECOVERY_KEY" "$PANEL_ROOT/.env" <<\'NODE\'',
      'const fs = require("fs"); const dotenv = require("dotenv");',
      'const [configPath, outputPath, key, currentEnvPath] = process.argv.slice(2);',
      'const currentEnv = dotenv.parse(fs.readFileSync(currentEnvPath));',
      'if (currentEnv.INTEGRATION_ENCRYPTION_KEY && currentEnv.INTEGRATION_ENCRYPTION_KEY !== key) throw new Error("Entered encryption key does not match the currently configured key.");',
      'const config = JSON.parse(fs.readFileSync(configPath, "utf8"));',
      'const environment = config.environment || {};',
      'const ignored = new Set(["INTEGRATION_ENCRYPTION_KEY", "PATH", "HOME", "PWD", "OLDPWD", "SHELL", "SHLVL", "_", "TERM", "LANG", "USER", "LOGNAME", "HOSTNAME"]);',
      'const entries = Object.entries(environment).filter(([name, value]) => /^[A-Z_][A-Z0-9_]*$/.test(name) && value !== undefined && !ignored.has(name));',
      'entries.push(["INTEGRATION_ENCRYPTION_KEY", key]);',
      'fs.writeFileSync(outputPath, entries.map(([name, value]) => name + "=" + JSON.stringify(String(value))).join("\\n") + "\\n", { mode: 0o600 });',
      'NODE',
      'RESTORE_MONGODB_URI="$(node - "$STAGING_DIR/configuration.json" <<\'NODE\'',
      'const fs = require("fs"); const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); process.stdout.write(config.environment?.MONGODB_URI || "");',
      'NODE',
      ')"',
      'if [[ -z "$RESTORE_MONGODB_URI" ]]; then echo "Backup configuration does not contain MONGODB_URI."; exit 1; fi',
      'SERVICES_STOPPED=0',
      'on_error() { status=$?; if [[ "$SERVICES_STOPPED" -eq 1 ]]; then systemctl start nimbus-api nimbus-web || true; fi; exit "$status"; }',
      'trap on_error ERR',
      'systemctl stop nimbus-web nimbus-api',
      'SERVICES_STOPPED=1',
      'if ! mongorestore --uri="$RESTORE_MONGODB_URI" --archive="$STAGING_DIR/database.archive.gz" --gzip --drop --nsInclude="nimbus.*"; then',
      '  echo "Database restore failed. Attempting to roll back the safety dump."',
      '  mongorestore --uri="$CURRENT_MONGODB_URI" --archive="$SAFETY_DIR/database.before.archive.gz" --gzip --drop --nsInclude="nimbus.*" || true',
      '  systemctl start nimbus-api nimbus-web || true',
      '  SERVICES_STOPPED=0',
      '  exit 1',
      'fi',
      'node - "$RESTORE_MONGODB_URI" "$STAGING_DIR/manifest.json" "${jobId}" <<\'NODE\' || echo "Warning: backup job state reconciliation failed; inspect backup jobs after restart."',
      'const fs = require("fs"); const { MongoClient, ObjectId } = require("mongodb");',
      '(async () => {',
      '  const [uri, manifestPath, jobId] = process.argv.slice(2);',
      '  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));',
      '  const client = new MongoClient(uri);',
      '  await client.connect();',
      '  try {',
      '    const jobs = client.db("nimbus").collection("backupjobs");',
      '    const now = new Date();',
      '    await jobs.updateMany({ _id: { $ne: new ObjectId(jobId) }, status: { $in: ["queued", "running"] } }, { $set: { status: "failed", error: "Interrupted by Full Panel recovery; review before requeueing", completedAt: now, leaseUntil: null, currentServiceId: null } });',
      '    const results = manifest.serviceBackupResults || [];',
      '    const serviceCompleted = results.filter((item) => item.status === "completed").length;',
      '    const serviceFailed = results.length - serviceCompleted;',
      '    const panelArtifacts = manifest.panelArtifacts || {};',
      '    const panelCompleted = ["database", "configuration", "systemMetadata"].filter((key) => panelArtifacts[key]).length;',
      '    const failed = serviceFailed + (3 - panelCompleted);',
      '    const completed = serviceCompleted + panelCompleted + 1;',
      '    const total = results.length + 4;',
      '    await jobs.updateOne({ _id: new ObjectId(jobId) }, { $set: { status: failed === 0 ? "completed" : "failed", total, completed, failed, results, panelArtifacts, completedAt: now, leaseUntil: null, currentServiceId: null } });',
      '  } finally { await client.close(); }',
      '})().catch((error) => { console.error("Could not reconcile backup job state:", error.message); process.exitCode = 1; });',
      'NODE',
      'install -m 600 "$STAGING_DIR/restore.env" "$PANEL_ROOT/.env"',
      'systemctl start nimbus-api nimbus-web',
      'SERVICES_STOPPED=0',
      'rm -f "$STAGING_DIR/database.archive.gz" "$STAGING_DIR/configuration.json" "$STAGING_DIR/manifest.json" "$STAGING_DIR/restore.env"',
      'trap - ERR',
      'echo "Panel database and configuration restored. Safety backup: $SAFETY_DIR"',
      'echo "Next, sign in and use Admin Backups to restore customer service archives from the Full Panel manifest."',
    ].join("\n") + "\n";
    const scriptPath = join(stagingDir, "restore-panel.sh");
    await writeFile(scriptPath, script, { mode: 0o700 });
    await chmod(scriptPath, 0o700);
    return {
      jobId,
      stagingPath: stagingDir,
      scriptPath,
      command: "sudo bash " + scriptPath,
      manifestPath,
      warning: "This restores the panel database and configuration during maintenance. Customer service data archives must then be restored from the manifest using the Admin restore workflow.",
    };
  }

  private async findAdminDriveArtifact(jobId: string, artifactType: string) {
    const accessToken = await this.integrations.googleDriveAccessToken("admin");
    const query = new URLSearchParams({
      q: `appProperties has { key='nimbusPanelBackupId' and value='${jobId}' } and appProperties has { key='nimbusArtifactType' and value='${artifactType}' } and trashed = false`,
      pageSize: "1",
      orderBy: "createdTime desc",
      fields: "files(id,appProperties)",
    });
    const response = await axios.get("https://www.googleapis.com/drive/v3/files?" + query.toString(), {
      headers: { authorization: "Bearer " + accessToken },
    });
    const file = response.data?.files?.[0];
    const props = file?.appProperties ?? {};
    if (!file?.id || !props.nimbusSha256 || !props.nimbusIv || !props.nimbusTag || !props.nimbusKeyVersion || !props.nimbusAlgorithm) {
      throw new NotFoundException("The requested Full Panel Backup artifact could not be found in the Admin Drive");
    }
    return {
      fileId: String(file.id),
      checksum: String(props.nimbusSha256),
      encryptionMetadata: {
        algorithm: String(props.nimbusAlgorithm),
        iv: String(props.nimbusIv),
        authTag: String(props.nimbusTag),
        keyVersion: String(props.nimbusKeyVersion),
      },
    };
  }

  async restoreServicesFromFullPanelManifest(jobId: string, user: { id: string; role: string }, confirmed: boolean) {
    if (!["owner", "admin"].includes(user.role)) throw new BadRequestException("Admin permission required");
    if (confirmed !== true) throw new BadRequestException("Explicit confirmation is required before restoring customer services");
    const job = await this.jobs.findById(jobId);
    if (!job || job.mode !== "full-panel") throw new NotFoundException("Full Panel Backup job not found");
    const artifact = await this.findAdminDriveArtifact(jobId, "manifest");
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-manifest-"));
    try {
      const manifestPath = join(tempDir, "manifest.json");
      await this.downloadAdminPanelArtifact(artifact, manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        customers?: Array<{ customerId: string; customerName: string; services?: Array<Record<string, any>> }>;
      };
      const backupIds: string[] = [];
      const failures: string[] = [];
      for (const customer of manifest.customers ?? []) {
        if (!Types.ObjectId.isValid(customer.customerId)) continue;
        for (const item of customer.services ?? []) {
          const serviceId = String(item.serviceId ?? "");
          const backupId = String(item.backupId ?? "");
          const ownerId = String(customer.customerId);
          if (!Types.ObjectId.isValid(serviceId) || !Types.ObjectId.isValid(backupId) || !item.driveFileId || !item.checksum || !item.encryptionMetadata) {
            failures.push("Invalid manifest entry for customer " + customer.customerName);
            continue;
          }
          try {
            const service = await this.services.get(serviceId, user as never);
            if (service.ownerId.toString() !== ownerId) throw new BadRequestException("Service owner does not match the manifest customer");
            let backup = await this.backups.findById(backupId);
            if (!backup) {
              backup = await this.backups.create({
                _id: new Types.ObjectId(backupId),
                serviceId: new Types.ObjectId(serviceId),
                ownerId: new Types.ObjectId(ownerId),
                requestedBy: new Types.ObjectId(user.id),
                driveOwnerType: "admin",
                destination: "gdrive",
                status: "completed",
                progressStage: "completed",
                trigger: item.trigger === "scheduled" ? "scheduled" : "manual",
                createdBy: new Types.ObjectId(user.id),
                backupName: String(item.backupName ?? (service.name + " backup")),
                backupType: "service",
                remoteFileId: String(item.driveFileId),
                checksum: String(item.checksum),
                sizeBytes: Number(item.sizeBytes ?? 0),
                encryptionMetadata: item.encryptionMetadata,
                verificationStatus: "verified",
                manifest: {
                  backupId,
                  serviceId,
                  ownerId,
                  serviceName: service.name,
                  serviceType: service.type,
                  archiveChecksum: String(item.checksum),
                  recoveredFromFullPanelJob: jobId,
                },
              });
            }
            if (backup.remoteFileId !== String(item.driveFileId) || !backup.encryptionMetadata) {
              backup.remoteFileId = String(item.driveFileId);
              backup.checksum = String(item.checksum);
              backup.sizeBytes = Number(item.sizeBytes ?? 0);
              backup.encryptionMetadata = item.encryptionMetadata;
              backup.driveOwnerType = "admin";
              backup.destination = "gdrive";
              backup.status = "completed";
              backup.progressStage = "completed";
              backup.verificationStatus = "verified";
              await backup.save();
            }
            backupIds.push(backup._id!.toString());
          } catch (error) {
            failures.push(serviceId + ": " + (error instanceof Error ? error.message : "could not restore manifest record"));
          }
        }
      }
      if (!backupIds.length) throw new BadRequestException("No valid service backup entries were found in the Full Panel manifest. " + failures.slice(0, 3).join("; "));
      const restoreJob = await this.enqueueRestoreJob(backupIds, user, true);
      return { ...restoreJob, manifestJobId: jobId, skipped: failures.length, warnings: failures.slice(0, 20) };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async createFullPanelBackup(user: { id: string; role: string }) {
    if (!["owner", "admin"].includes(user.role)) throw new BadRequestException("Admin permission required");
    const driveStatus = await this.integrations.googleDriveStatus("admin");
    if (!driveStatus.connected) throw new BadRequestException("Connect the Admin Google Drive before creating a Full Panel Backup");
    const activeJob = await this.jobs.findOne({ mode: "full-panel", status: { $in: ["queued", "running"] } });
    if (activeJob) throw new BadRequestException("A Full Panel Backup is already queued or running");
    const services = await this.services.listFor(user as never, {}, 1000);
    if (services.length >= 1000) throw new BadRequestException("This panel exceeds the 1000-service Full Panel Backup limit.");
    const job = await this.jobs.create({
      requestedBy: new Types.ObjectId(user.id),
      ownerId: new Types.ObjectId(user.id),
      ownerType: "admin",
      requesterRole: user.role,
      serviceIds: services.map((service) => service._id!),
      trigger: "manual",
      destination: "gdrive",
      mode: "full-panel",
      status: "queued",
      total: services.length + 4,
      completed: 0,
      failed: 0,
      results: [],
      panelArtifacts: {},
    });
    return { jobId: job._id!.toString(), status: job.status, total: job.total, serviceCount: services.length };
  }

  async createAdminBatch(
    dto: { mode: "all-customers" | "selected-customers" | "selected-services"; customerIds?: string[]; serviceIds?: string[] },
    user: { id: string; role: string },
  ) {
    if (!["owner", "admin"].includes(user.role)) throw new BadRequestException("Admin permission required");
    if (!["all-customers", "selected-customers", "selected-services"].includes(dto.mode)) throw new BadRequestException("Invalid Admin backup mode");
    const allServices = await this.services.listFor(user as never, {}, 1000);
    let selected = allServices;
    if (dto.mode === "selected-services") {
      const ids = new Set(dto.serviceIds ?? []);
      if (ids.size === 0) throw new BadRequestException("Select at least one service");
      selected = allServices.filter((service) => ids.has(service._id!.toString()));
      if (selected.length !== ids.size) throw new BadRequestException("One or more selected services were not found");
    } else if (dto.mode === "selected-customers") {
      const ids = new Set(dto.customerIds ?? []);
      if (ids.size === 0) throw new BadRequestException("Select at least one customer");
      selected = allServices.filter((service) => ids.has(service.ownerId.toString()));
      if (selected.length === 0) throw new BadRequestException("The selected customers have no eligible services");
    }
    if (!selected.length) throw new BadRequestException("No eligible services were found");
    return this.enqueueBackupJob(selected.map((service) => service._id!.toString()), user, "manual", "gdrive");
  }

  async driveSummary(user: { id: string; role: string }) {
    const filter = user.role === "customer"
      ? { ownerId: new Types.ObjectId(user.id), driveOwnerType: "customer", status: "completed" }
      : { driveOwnerType: "admin", status: "completed" };
    const [totalBackups, latest, sizes, fullPanelBackupCount, latestFullPanelBackup] = await Promise.all([
      this.backups.countDocuments(filter),
      this.backups.findOne(filter).sort({ createdAt: -1 }).select("createdAt").lean(),
      this.backups.aggregate([{ $match: filter }, { $group: { _id: null, totalBytes: { $sum: "$sizeBytes" } } }]),
      user.role === "customer" ? Promise.resolve(0) : this.jobs.countDocuments({ mode: "full-panel", status: "completed" }),
      user.role === "customer" ? Promise.resolve(null) : this.jobs.findOne({ mode: "full-panel", status: "completed" }).sort({ createdAt: -1 }).select("createdAt").lean(),
    ]);
    return {
      totalBackups,
      lastSuccessfulBackup: latest?.createdAt ?? null,
      totalSizeBytes: sizes[0]?.totalBytes ?? 0,
      fullPanelBackupCount,
      lastFullPanelBackupAt: latestFullPanelBackup?.createdAt ?? null,
    };
  }

  async list(user: { id: string; role: string }, serviceId?: string) {
    const filter: Record<string, unknown> = {};
    if (serviceId) {
      const service = await this.services.get(serviceId, user as never);
      filter.serviceId = service._id;
    } else if (user.role === "customer") {
      const ownedServices = await this.services.listFor(user as never, {}, 1000);
      const ids = ownedServices.map((service) => service._id);
      filter.serviceId = { $in: ids };
    }
    return this.backups.find(filter).sort({ createdAt: -1 }).limit(100).populate("serviceId", "name type").populate("ownerId", "displayName username email");
  }

  async create(serviceId: string, user: { id: string; role: string }, trigger: string, destination = "gdrive", internal = false, jobId?: string) {
    if (!["gdrive", "local"].includes(destination)) throw new BadRequestException("Invalid backup destination");
    if (destination === "local" && !internal) throw new BadRequestException("User-requested backups must be stored in Google Drive");
    if (!["manual", "scheduled", "pre-update", "pre-reinstall", "pre-restore"].includes(trigger)) throw new BadRequestException("Invalid backup trigger");
    const service = await this.services.get(serviceId, user as never);
    const node = await this.nodes.get(service.nodeId.toString());
    const driveOwnerType = user.role === "customer" ? "customer" : "admin";
    const driveOwnerId = driveOwnerType === "customer" ? service.ownerId : undefined;
    let backup = jobId
      ? await this.backups.findOne({ jobId: new Types.ObjectId(jobId), serviceId: service._id })
      : null;
    if (backup?.status === "completed") return backup;
    if (backup) {
      backup.status = "running";
      backup.error = undefined;
      backup.completedAt = undefined;
      backup.verificationStatus = "pending";
      backup.backupName = service.name + " backup";
      backup.backupType = "service";
      backup.progressStage = "queued";
      backup.manifest = {
        backupId: backup._id!.toString(),
        serviceId,
        ownerId: service.ownerId.toString(),
        serviceName: service.name,
        serviceType: service.type,
        createdAt: new Date().toISOString(),
      };
      await backup.save();
    } else {
      backup = await this.backups.create({
        serviceId: new Types.ObjectId(serviceId),
        ...(jobId ? { jobId: new Types.ObjectId(jobId) } : {}),
        ownerId: service.ownerId,
        requestedBy: new Types.ObjectId(user.id),
        driveOwnerType,
        ...(driveOwnerId ? { driveOwnerId } : {}),
        destination,
        status: "running",
        progressStage: "queued",
        trigger,
        createdBy: new Types.ObjectId(user.id),
        backupName: service.name + " backup",
        backupType: "service",
        verificationStatus: "pending",
        manifest: {
          backupId: "pending",
          serviceId,
          ownerId: service.ownerId.toString(),
          serviceName: service.name,
          serviceType: service.type,
          createdAt: new Date().toISOString(),
        },
      });
      backup.manifest = { ...(backup.manifest ?? {}), backupId: backup._id!.toString() };
    }
    let tempDir: string | undefined;
    try {
      backup.progressStage = "creating_snapshot";
      await backup.save();
      const result = await this.nodes.agentCall(node, "/backups/create", {
        serviceId,
        backupId: backup._id!.toString(),
      }, "POST", 10 * 60 * 1000);
      backup.sizeBytes = result.sizeBytes;
      backup.checksum = result.checksum;
      if (destination === "gdrive") {
        tempDir = await mkdtemp(join(tmpdir(), "nimbus-service-backup-"));
        const archivePath = join(tempDir, "service.tar.gz");
        const encryptedPath = join(tempDir, "service.tar.gz.enc");
        const source = await this.nodes.downloadBackupArchiveStream(node, serviceId, backup._id!.toString());
        const hash = createHash("sha256");
        const hashTransform = new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(source, hashTransform, createWriteStream(archivePath, { mode: 0o600 }));
        if (!this.verifyChecksumDigest(hash.digest(), result.checksum)) {
          throw new BadRequestException("Downloaded archive failed checksum verification");
        }
        backup.progressStage = "encrypting";
        await backup.save();
        const ownerRecord = await this.backups.db.collection("users").findOne(
          { _id: service.ownerId },
          { projection: { displayName: 1, username: 1, email: 1 } },
        );
        const ownerName = String(ownerRecord?.displayName || ownerRecord?.username || ownerRecord?.email || service.ownerId.toString());
        const encryptionMetadata = await this.encryptArchiveFile(archivePath, encryptedPath);
        backup.encryptionMetadata = encryptionMetadata;
        backup.manifest = { ...(backup.manifest ?? {}), encryption: encryptionMetadata, archiveChecksum: result.checksum };
        const encryptedStat = await stat(encryptedPath);
        backup.remoteFileId = await this.uploadGoogleDriveArchive(
          encryptedPath,
          encryptedStat.size,
          `nimbus-${serviceId}-${backup._id!.toString()}.tar.gz.enc`,
          driveOwnerType,
          driveOwnerId?.toString(),
          service.type,
          service.name,
          ownerName,
          service.ownerId.toString(),
          backup._id!.toString(),
          result.checksum,
          encryptionMetadata,
          async (stage) => { backup.progressStage = stage; await backup.save(); },
        );
        backup.verificationStatus = "verified";
        await this.nodes.agentCall(node, "/backups/delete", { serviceId, backupId: backup._id!.toString() }, "POST", 30_000)
          .catch((error) => console.error("[backups] could not remove temporary plaintext archive:", error instanceof Error ? error.message : "unknown error"));
      } else {
        backup.verificationStatus = "verified";
      }
      backup.status = "completed";
      backup.progressStage = "completed";
      backup.completedAt = new Date();
    } catch (err) {
      backup.status = "failed";
      backup.progressStage = "failed";
      backup.verificationStatus = "failed";
      backup.error = (err as Error).message;
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
    await backup.save();
    await this.audit.log({
      actorId: user.id,
      action: "backups.create",
      targetId: backup._id!.toString(),
      sensitive: true,
    });
    return backup;
  }

  async download(backupId: string, user: { id: string; role: string }) {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    if (backup.status !== "completed") throw new BadRequestException("Only completed backups can be downloaded");
    const service = await this.services.get(backup.serviceId.toString(), user as never);
    const node = await this.nodes.get(service.nodeId.toString());
    if (!backup.checksum) throw new BadRequestException("This backup has no integrity checksum and cannot be safely downloaded");
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-download-"));
    const archivePath = join(tempDir, "download.tar.gz");
    try {
      if (backup.remoteFileId) {
        const ownerType = backup.driveOwnerType ?? "admin";
        const ownerId = ownerType === "customer" ? backup.driveOwnerId?.toString() : undefined;
        const accessToken = await this.integrations.googleDriveAccessToken(ownerType, ownerId);
        const encryptedPath = join(tempDir, "download.enc");
        const response = await axios.get(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.remoteFileId)}?alt=media`,
          { headers: { authorization: `Bearer ${accessToken}` }, responseType: "stream", timeout: 60 * 60 * 1000 },
        );
        await pipeline(response.data, createWriteStream(encryptedPath, { mode: 0o600 }));
        if (backup.encryptionMetadata) {
          await this.decryptArchiveFile(encryptedPath, archivePath, backup.encryptionMetadata);
        } else {
          await pipeline(createReadStream(encryptedPath), createWriteStream(archivePath, { mode: 0o600 }));
        }
      } else {
        const source = await this.nodes.downloadBackupArchiveStream(node, service._id!.toString(), backupId);
        await pipeline(source, createWriteStream(archivePath, { mode: 0o600 }));
      }
      const digest = Buffer.from(await this.hashFile(archivePath, "hex"), "hex");
      if (!this.verifyChecksumDigest(digest, backup.checksum)) {
        throw new BadRequestException("Backup integrity verification failed. Download was stopped.");
      }
      await this.audit.log({ actorId: user.id, action: "backups.download", targetType: "backup", targetId: backupId, sensitive: true });
      const safeName = service.name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "service";
      const stream = createReadStream(archivePath);
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(tempDir, { recursive: true, force: true });
      };
      stream.once("close", () => { void cleanup(); });
      stream.once("error", () => { void cleanup(); });
      return { stream, filename: `nimbus-${safeName}-${backupId}.tar.gz`, cleanup };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async delete(backupId: string, user: { id: string; role: string }) {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    const activeRestore = await this.jobs.findOne({
      mode: "restore-batch",
      status: { $in: ["queued", "running"] },
      backupIds: new Types.ObjectId(backupId),
    });
    if (activeRestore) throw new BadRequestException("This backup is currently queued for restore and cannot be deleted");
    const service = await this.services.get(backup.serviceId.toString(), user as never);
    if (backup.remoteFileId) {
      const ownerType = backup.driveOwnerType ?? "admin";
      const ownerId = ownerType === "customer" ? backup.driveOwnerId?.toString() : undefined;
      const accessToken = await this.integrations.googleDriveAccessToken(ownerType, ownerId);
      try {
        await axios.delete(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.remoteFileId)}`, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
      } catch (error) {
        if (!(axios.isAxiosError(error) && error.response?.status === 404)) {
          throw new BadRequestException("Could not delete the backup file from Google Drive");
        }
      }
    }
    const node = await this.nodes.get(service.nodeId.toString());
    const removeLocal = this.nodes.agentCall(node, "/backups/delete", { serviceId: service._id!.toString(), backupId }, "POST", 30_000);
    if (backup.remoteFileId) await removeLocal.catch(() => undefined); // Remote Drive is authoritative; local cache may be absent.
    else await removeLocal;
    await this.backups.deleteOne({ _id: backup._id });
    await this.audit.log({ actorId: user.id, action: "backups.delete", targetType: "backup", targetId: backupId, sensitive: true });
    return { deleted: true };
  }

  async enqueueRestoreJob(
    backupIds: string[],
    user: { id: string; role: string },
    confirmed: boolean,
  ) {
    if (confirmed !== true) throw new BadRequestException("Explicit confirmation is required before restoring service data");
    if (!backupIds.length || backupIds.length > 1000) throw new BadRequestException("Select between 1 and 1000 completed backups");
    const uniqueIds = [...new Set(backupIds)];
    const selected = [];
    for (const backupId of uniqueIds) {
      if (!Types.ObjectId.isValid(backupId)) throw new BadRequestException("Invalid backup identifier");
      const backup = await this.backups.findById(backupId);
      if (!backup || backup.status !== "completed") throw new BadRequestException("One or more selected backups are unavailable");
      const service = await this.services.get(backup.serviceId.toString(), user as never);
      selected.push({ backup, service });
    }
    const serviceIds = selected.map((item) => item.service._id!);
    if (new Set(serviceIds.map((id) => id.toString())).size !== serviceIds.length) {
      throw new BadRequestException("Select only one backup per service in a restore job");
    }
    const activeRestore = await this.jobs.findOne({
      mode: "restore-batch",
      status: { $in: ["queued", "running"] },
      serviceIds: { $in: serviceIds },
    });
    if (activeRestore) throw new BadRequestException("A restore is already queued or running for one of the selected services");
    const job = await this.jobs.create({
      requestedBy: new Types.ObjectId(user.id),
      ownerId: new Types.ObjectId(user.id),
      ownerType: user.role === "customer" ? "customer" : "admin",
      requesterRole: user.role,
      serviceIds,
      backupIds: selected.map((item) => item.backup._id!),
      trigger: "manual",
      destination: "gdrive",
      mode: "restore-batch",
      status: "queued",
      total: selected.length,
      completed: 0,
      failed: 0,
      results: [],
    });
    return { jobId: job._id!.toString(), status: job.status, total: job.total };
  }

  async restoreAdminSelection(
    dto: { mode: "selected-services" | "selected-customer"; backupIds?: string[]; customerId?: string; confirm?: boolean },
    user: { id: string; role: string },
  ) {
    if (!["owner", "admin"].includes(user.role)) throw new BadRequestException("Admin permission required");
    if (dto.confirm !== true) throw new BadRequestException("Explicit confirmation is required before restoring customer data");
    let backupIds = dto.backupIds ?? [];
    if (dto.mode === "selected-customer") {
      if (!dto.customerId || !Types.ObjectId.isValid(dto.customerId)) throw new BadRequestException("Select a valid customer");
      const backups = await this.backups.find({ ownerId: new Types.ObjectId(dto.customerId), status: "completed", trigger: { $in: ["manual", "scheduled"] } }).sort({ createdAt: -1 });
      const latestByService = new Map<string, string>();
      for (const backup of backups) {
        const serviceId = backup.serviceId.toString();
        if (!latestByService.has(serviceId)) latestByService.set(serviceId, backup._id!.toString());
      }
      backupIds = [...latestByService.values()];
    } else if (dto.mode !== "selected-services") {
      throw new BadRequestException("Invalid restore mode");
    }
    return this.enqueueRestoreJob(backupIds, user, true);
  }

  private async processRestoreJob(job: BackupJobDocument, user: { id: string; role: string }) {
    const completedIds = new Set((job.results ?? []).map((result) => result.backupId).filter(Boolean));
    for (const backupObjectId of job.backupIds ?? []) {
      const backupId = backupObjectId.toString();
      if (completedIds.has(backupId)) continue;
      const backup = await this.backups.findById(backupId);
      if (!backup) {
        job.results.push({ serviceId: "unknown", backupId, status: "failed", error: "Backup record no longer exists" });
        job.failed += 1;
        await job.save();
        continue;
      }
      job.currentServiceId = backup.serviceId;
      job.leaseUntil = new Date(Date.now() + 8 * 60 * 60 * 1000);
      await job.save();
      try {
        if (backup.lastRestoredAt && job.createdAt && backup.lastRestoredAt >= job.createdAt) {
          job.results.push({ serviceId: backup.serviceId.toString(), backupId, status: "completed" });
          job.completed += 1;
        } else {
          await this.restore(backupId, user, true);
          job.results.push({ serviceId: backup.serviceId.toString(), backupId, status: "completed" });
          job.completed += 1;
        }
      } catch (error) {
        job.results.push({ serviceId: backup.serviceId.toString(), backupId, status: "failed", error: error instanceof Error ? error.message : "Restore failed" });
        job.failed += 1;
      }
      await job.save();
    }
    job.status = job.failed === 0 ? "completed" : "failed";
    job.currentServiceId = undefined;
    job.leaseUntil = undefined;
    job.completedAt = new Date();
    await job.save();
    await this.notifications.notify(
      job.requestedBy.toString(),
      "backup",
      job.status === "completed" ? "Restore job completed" : "Restore job failed",
      job.completed + " of " + job.total + " service restores completed; " + job.failed + " failed.",
    );
    await this.audit.log({
      actorId: job.requestedBy.toString(),
      action: "backups.restore-job.completed",
      targetType: "restore-job",
      targetId: job._id!.toString(),
      detail: "total=" + job.total + " restored=" + job.completed + " failed=" + job.failed,
      sensitive: true,
    });
  }


  /** Restore a verified archive only after explicit UI confirmation. */
  async restore(backupId: string, user: { id: string; role: string }, confirmed = false) {
    if (!confirmed) throw new BadRequestException("Explicit confirmation is required before restoring customer data");
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    if (backup.status !== "completed") throw new BadRequestException("Backup is not restorable");
    const service = await this.services.get(backup.serviceId.toString(), user as never);
    const archivedType = backup.manifest?.serviceType;
    if (typeof archivedType === "string" && archivedType !== service.type) {
      throw new BadRequestException("This backup was created for a different service type and cannot be restored here");
    }
    if (!backup.checksum) throw new BadRequestException("This backup has no integrity checksum and cannot be safely restored");
    const node = await this.nodes.get(service.nodeId.toString());

    if (backup.remoteFileId) {
      const ownerType = backup.driveOwnerType ?? "admin";
      const ownerId = ownerType === "customer" ? backup.driveOwnerId?.toString() : undefined;
      const accessToken = await this.integrations.googleDriveAccessToken(ownerType, ownerId);
      const tempDir = await mkdtemp(join(tmpdir(), "nimbus-restore-"));
      try {
        const encryptedPath = join(tempDir, "drive-archive.enc");
        const archivePath = join(tempDir, "restore.tar.gz");
        const response = await axios.get(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.remoteFileId)}?alt=media`,
          { headers: { authorization: `Bearer ${accessToken}` }, responseType: "stream", timeout: 60 * 60 * 1000 },
        );
        await pipeline(response.data, createWriteStream(encryptedPath, { mode: 0o600 }));
        if (backup.encryptionMetadata) {
          await this.decryptArchiveFile(encryptedPath, archivePath, backup.encryptionMetadata);
        } else {
          await pipeline(createReadStream(encryptedPath), createWriteStream(archivePath, { mode: 0o600 }));
        }
        const archiveDigest = Buffer.from(await this.hashFile(archivePath, "hex"), "hex");
        if (!backup.checksum || !this.verifyChecksumDigest(archiveDigest, backup.checksum)) {
          throw new BadRequestException("Backup integrity verification failed. The service was not changed.");
        }
        await this.nodes.uploadBackupArchiveFile(node, service._id!.toString(), backupId, archivePath, backup.checksum);
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        const details = axios.isAxiosError(error) ? (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message : undefined;
        throw new BadRequestException(details ?? (error instanceof Error ? error.message : "Could not download and verify this backup from Google Drive"));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    } else {
      const tempDir = await mkdtemp(join(tmpdir(), "nimbus-local-restore-"));
      try {
        const archivePath = join(tempDir, "restore.tar.gz");
        const source = await this.nodes.downloadBackupArchiveStream(node, service._id!.toString(), backupId);
        await pipeline(source, createWriteStream(archivePath, { mode: 0o600 }));
        const digest = Buffer.from(await this.hashFile(archivePath, "hex"), "hex");
        if (!backup.checksum || !this.verifyChecksumDigest(digest, backup.checksum)) {
          throw new BadRequestException("Local backup integrity verification failed. The service was not changed.");
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }

    // Keep a fresh node-local safety snapshot before replacing service data.
    const safetyBackup = await this.create(service._id!.toString(), user, "pre-restore", "gdrive", true);
    const restoreRequest = { serviceId: service._id!.toString(), backupId };
    if (safetyBackup.status !== "completed") {
      await this.nodes.agentCall(node, "/backups/delete", restoreRequest, "POST", 30_000).catch(() => undefined);
      throw new BadRequestException("Could not create a safety backup. The existing service data was not changed.");
    }

    try {
      await this.nodes.agentCall(node, "/backups/restore", restoreRequest, "POST", 10 * 60 * 1000);
      await this.nodes.agentCall(node, "/backups/restore-commit", restoreRequest, "POST", 10 * 60 * 1000);
    } finally {
      await this.nodes.agentCall(node, "/backups/delete", restoreRequest, "POST", 30_000).catch(() => undefined);
    }
    backup.lastRestoredAt = new Date();
    await backup.save();
    await this.audit.log({
      actorId: user.id,
      action: "backups.restore",
      targetType: "backup",
      targetId: backupId,
      detail: `service=${service._id!.toString()} safetyBackup=${safetyBackup._id!.toString()}`,
      sensitive: true,
    });
    return { ok: true, restored: true, safetyBackupId: safetyBackup._id!.toString() };
  }

  private encryptArchive(archive: Buffer): {
    data: Buffer;
    metadata: { algorithm: string; iv: string; authTag: string; keyVersion: string };
  } {
    const key = createHash("sha256").update(env.integrationEncryptionKey).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(archive), cipher.final()]);
    return {
      data,
      metadata: {
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        keyVersion: "integration-key-v1",
      },
    };
  }

  private async encryptArchiveFile(sourcePath: string, destinationPath: string) {
    const key = createHash("sha256").update(env.integrationEncryptionKey).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    await pipeline(createReadStream(sourcePath), cipher, createWriteStream(destinationPath, { mode: 0o600 }));
    return {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: "integration-key-v1",
    };
  }

  private async decryptArchiveFile(
    encryptedPath: string,
    destinationPath: string,
    metadata: { algorithm: string; iv: string; authTag: string; keyVersion: string },
  ) {
    if (metadata.algorithm !== "aes-256-gcm" || metadata.keyVersion !== "integration-key-v1") {
      throw new BadRequestException("This backup uses an unsupported encryption format");
    }
    try {
      const key = createHash("sha256").update(env.integrationEncryptionKey).digest();
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(metadata.iv, "base64"));
      decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));
      await pipeline(createReadStream(encryptedPath), decipher, createWriteStream(destinationPath, { mode: 0o600 }));
    } catch {
      throw new BadRequestException("Backup decryption or authentication failed. The encryption key may have changed.");
    }
  }

  private async hashFile(path: string, encoding: "hex" | "base64" = "hex"): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest(encoding);
  }

  private decryptArchive(
    encrypted: Buffer,
    metadata: { algorithm: string; iv: string; authTag: string; keyVersion: string },
  ): Buffer {
    if (metadata.algorithm !== "aes-256-gcm" || metadata.keyVersion !== "integration-key-v1") {
      throw new BadRequestException("This backup uses an unsupported encryption format");
    }
    try {
      const key = createHash("sha256").update(env.integrationEncryptionKey).digest();
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(metadata.iv, "base64"));
      decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch {
      throw new BadRequestException("Backup decryption failed. The encryption key may have changed.");
    }
  }

  private async uploadResumableDriveUpload(
    accessToken: string,
    metadata: Record<string, unknown>,
    archive: Buffer,
  ): Promise<string> {
    const start = await axios.post(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name",
      metadata,
      {
        headers: {
          authorization: "Bearer " + accessToken,
          "content-type": "application/json",
          "x-upload-content-type": "application/octet-stream",
          "x-upload-content-length": String(archive.length),
        },
        timeout: 30_000,
      },
    );
    const sessionUri = start.headers.location as string | undefined;
    if (!sessionUri) throw new BadRequestException("Google Drive did not return a resumable upload session");
    const chunkSize = 8 * 1024 * 1024;
    let offset = 0;
    let finalData: { id?: string } | undefined;
    while (offset < archive.length) {
      const end = Math.min(offset + chunkSize, archive.length) - 1;
      const chunk = archive.subarray(offset, end + 1);
      let retries = 0;
      let chunkFinished = false;
      while (!chunkFinished) {
        try {
          const response = await axios.put(sessionUri, chunk, {
            headers: {
              authorization: "Bearer " + accessToken,
              "content-type": "application/octet-stream",
              "content-length": String(chunk.length),
              "content-range": "bytes " + offset + "-" + end + "/" + archive.length,
            },
            timeout: 60 * 60 * 1000,
            maxBodyLength: Infinity,
            validateStatus: (status) => status === 308 || status === 200 || status === 201,
          });
          if (response.status === 308) {
            const range = String(response.headers.range ?? "");
            const match = /(\d+)-(\d+)$/.exec(range);
            offset = match ? Number(match[2]) + 1 : 0;
          } else {
            finalData = response.data as { id?: string };
            offset = archive.length;
          }
          chunkFinished = true;
        } catch (error) {
          retries += 1;
          if (retries > 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (2 ** retries), 15_000)));
          const probe = await axios.put(sessionUri, Buffer.alloc(0), {
            headers: {
              authorization: "Bearer " + accessToken,
              "content-length": "0",
              "content-range": "bytes */" + archive.length,
            },
            timeout: 30_000,
            validateStatus: (status) => status === 308 || status === 200 || status === 201,
          });
          if (probe.status === 200 || probe.status === 201) {
            finalData = probe.data as { id?: string };
            offset = archive.length;
            chunkFinished = true;
          } else {
            const range = String(probe.headers.range ?? "");
            const match = /(\d+)-(\d+)$/.exec(range);
            const confirmedOffset = match ? Number(match[2]) + 1 : 0;
            if (confirmedOffset !== offset) {
              offset = confirmedOffset;
              chunkFinished = true;
            }
          }
        }
      }
    }
    if (!finalData?.id) {
      const probe = await axios.put(sessionUri, Buffer.alloc(0), {
        headers: {
          authorization: "Bearer " + accessToken,
          "content-length": "0",
          "content-range": "bytes */" + archive.length,
        },
        timeout: 30_000,
        validateStatus: (status) => status === 308 || status === 200 || status === 201,
      });
      if (probe.status === 200 || probe.status === 201) finalData = probe.data as { id?: string };
    }
    if (!finalData?.id) throw new BadRequestException("Google Drive did not confirm the completed resumable upload");
    return finalData.id;
  }

  private async uploadResumableDriveFile(
    accessToken: string,
    metadata: Record<string, unknown>,
    archivePath: string,
    totalBytes: number,
  ): Promise<string> {
    const start = await axios.post(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name",
      metadata,
      {
        headers: {
          authorization: "Bearer " + accessToken,
          "content-type": "application/json",
          "x-upload-content-type": "application/octet-stream",
          "x-upload-content-length": String(totalBytes),
        },
        timeout: 30_000,
      },
    );
    const sessionUri = start.headers.location as string | undefined;
    if (!sessionUri) throw new BadRequestException("Google Drive did not return a resumable upload session");
    const chunkSize = 8 * 1024 * 1024;
    let offset = 0;
    let finalData: { id?: string } | undefined;
    while (offset < totalBytes) {
      const end = Math.min(offset + chunkSize, totalBytes) - 1;
      let retries = 0;
      let chunkFinished = false;
      while (!chunkFinished) {
        try {
          const response = await axios.put(sessionUri, createReadStream(archivePath, { start: offset, end }), {
            headers: {
              authorization: "Bearer " + accessToken,
              "content-type": "application/octet-stream",
              "content-length": String(end - offset + 1),
              "content-range": "bytes " + offset + "-" + end + "/" + totalBytes,
            },
            timeout: 60 * 60 * 1000,
            maxBodyLength: Infinity,
            validateStatus: (status) => status === 308 || status === 200 || status === 201,
          });
          if (response.status === 308) {
            const range = String(response.headers.range ?? "");
            const match = /(\d+)-(\d+)$/.exec(range);
            offset = match ? Number(match[2]) + 1 : 0;
          } else {
            finalData = response.data as { id?: string };
            offset = totalBytes;
          }
          chunkFinished = true;
        } catch (error) {
          retries += 1;
          if (retries > 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (2 ** retries), 15_000)));
          const probe = await axios.put(sessionUri, Buffer.alloc(0), {
            headers: {
              authorization: "Bearer " + accessToken,
              "content-length": "0",
              "content-range": "bytes */" + totalBytes,
            },
            timeout: 30_000,
            validateStatus: (status) => status === 308 || status === 200 || status === 201,
          });
          if (probe.status === 200 || probe.status === 201) {
            finalData = probe.data as { id?: string };
            offset = totalBytes;
            chunkFinished = true;
          } else {
            const range = String(probe.headers.range ?? "");
            const match = /(\d+)-(\d+)$/.exec(range);
            const confirmedOffset = match ? Number(match[2]) + 1 : 0;
            if (confirmedOffset !== offset) {
              offset = confirmedOffset;
              chunkFinished = true;
            }
          }
        }
      }
    }
    if (!finalData?.id) {
      const probe = await axios.put(sessionUri, Buffer.alloc(0), {
        headers: {
          authorization: "Bearer " + accessToken,
          "content-length": "0",
          "content-range": "bytes */" + totalBytes,
        },
        timeout: 30_000,
        validateStatus: (status) => status === 308 || status === 200 || status === 201,
      });
      if (probe.status === 200 || probe.status === 201) finalData = probe.data as { id?: string };
    }
    if (!finalData?.id) throw new BadRequestException("Google Drive did not confirm the completed resumable upload");
    return finalData.id;
  }

  private async uploadGoogleDriveArchive(
    archivePath: string,
    archiveSize: number,
    filename: string,
    ownerType: "admin" | "customer",
    ownerId: string | undefined,
    serviceType: string,
    serviceName: string,
    customerFolderName: string,
    customerId: string,
    backupId: string,
    checksum: string,
    encryptionMetadata: { algorithm: string; iv: string; authTag: string; keyVersion: string },
    onStage?: (stage: "uploading" | "verifying") => Promise<void>,
  ): Promise<string> {
    const accessToken = await this.integrations.googleDriveAccessToken(ownerType, ownerId);
    const parentFolderId = await this.integrations.googleDriveBackupFolder(ownerType, customerId, serviceType, serviceName, customerFolderName);
    const existingQuery = new URLSearchParams({
      q: `'${parentFolderId}' in parents and appProperties has { key='nimbusBackupId' and value='${backupId}' } and trashed = false`,
      pageSize: "1",
      fields: "files(id)",
    });
    const existingResponse = await axios.get("https://www.googleapis.com/drive/v3/files?" + existingQuery.toString(), {
      headers: { authorization: "Bearer " + accessToken },
    });
    const existingFileId = existingResponse.data?.files?.[0]?.id as string | undefined;
    const newDigest = await this.hashFile(archivePath, "hex");
    if (existingFileId) {
      const existingBytes = await axios.get(
        "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(existingFileId) + "?alt=media",
        { headers: { authorization: "Bearer " + accessToken }, responseType: "stream", timeout: 60 * 60 * 1000 },
      );
      const existingHash = createHash("sha256");
      for await (const chunk of existingBytes.data as Readable) existingHash.update(chunk as Buffer);
      if (existingHash.digest("hex") === newDigest) return existingFileId;
      await axios.delete("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(existingFileId), {
        headers: { authorization: "Bearer " + accessToken },
      });
    }
    const fileMetadata = {
      name: filename,
      mimeType: "application/octet-stream",
      parents: [parentFolderId],
      appProperties: {
        nimbusBackupId: backupId,
        nimbusServiceId: filename.split("-")[1] ?? "",
        nimbusCustomerId: customerId,
        nimbusSha256: checksum,
        nimbusIv: encryptionMetadata.iv,
        nimbusTag: encryptionMetadata.authTag,
        nimbusKeyVersion: encryptionMetadata.keyVersion,
        nimbusAlgorithm: encryptionMetadata.algorithm,
      },
    };
    let fileId: string;
    try {
      await onStage?.("uploading");
      fileId = await this.uploadResumableDriveFile(accessToken, fileMetadata, archivePath, archiveSize);
      await onStage?.("verifying");
    } catch (error) {
      const details = axios.isAxiosError(error) ? (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message : undefined;
      throw new BadRequestException(details ?? (error instanceof Error ? error.message : "Google Drive resumable upload failed"));
    }
    try {
      const downloaded = await axios.get(
        "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media",
        { headers: { authorization: "Bearer " + accessToken }, responseType: "stream", timeout: 60 * 60 * 1000 },
      );
      const actualHash = createHash("sha256");
      for await (const chunk of downloaded.data as Readable) actualHash.update(chunk as Buffer);
      if (newDigest !== actualHash.digest("hex")) {
        throw new BadRequestException("Google Drive upload verification failed: downloaded content did not match the uploaded archive");
      }
      return fileId;
    } catch (error) {
      await axios.delete("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId), {
        headers: { authorization: "Bearer " + accessToken },
      }).catch(() => undefined);
      const details = axios.isAxiosError(error) ? (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message : undefined;
      throw new BadRequestException(details ?? "Google Drive upload verification failed");
    }
  }

  private verifyChecksumDigest(digest: Buffer, expected: string): boolean {
    const normalized = expected.replace(/^sha256:/i, "");
    return digest.toString("base64") === normalized || digest.toString("hex") === normalized;
  }

  /** Integrity verification helper (sha256) usable by scheduled verification jobs. */
  verifyChecksum(buffer: Buffer, expected: string): boolean {
    const digest = createHash("sha256").update(buffer).digest();
    return digest.toString("base64") === expected || digest.toString("hex") === expected;
  }
}
