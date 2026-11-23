import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import axios from "axios";
import { AuditService } from "../audit/audit.service";
import { Backup, BackupDocument } from "./backup.schema";
import { NodesService } from "../nodes/nodes.service";
import { ServicesService } from "../services/services.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { env } from "../../config/env";

/**
 * Backup orchestration. Heavy lifting (tar + integrity) happens on the node
 * agent; upload goes directly to Google Drive / S3 using encrypted OAuth
 * refresh tokens stored here. Restore never silently overwrites data — the
 * agent extracts to a staging directory first and the API records the restore.
 */
@Injectable()
export class BackupsService {
  constructor(
    @InjectModel(Backup.name) private readonly backups: Model<BackupDocument>,
    private readonly nodes: NodesService,
    private readonly services: ServicesService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
  ) {}

  async list(user: { id: string; role: string }, serviceId?: string) {
    const filter: Record<string, unknown> = {};
    if (serviceId) {
      const service = await this.services.get(serviceId, user as never);
      filter.serviceId = service._id;
    } else if (user.role === "customer") {
      const ownedServices = await this.services.listFor(user as never);
      const ids = ownedServices.map((service) => service._id);
      filter.serviceId = { $in: ids };
    }
    return this.backups.find(filter).sort({ createdAt: -1 }).limit(100).populate("serviceId", "name type");
  }

  async create(serviceId: string, user: { id: string; role: string }, trigger: string, destination = "local", internal = false) {
    if (!["gdrive", "local"].includes(destination)) throw new BadRequestException("Invalid backup destination");
    if (!["manual", "scheduled", "pre-update", "pre-reinstall", "pre-restore"].includes(trigger)) throw new BadRequestException("Invalid backup trigger");
    if (user.role === "customer" && destination !== "gdrive" && !internal) {
      throw new BadRequestException("Customer backups must be stored in the customer's connected Google Drive");
    }
    const service = await this.services.get(serviceId, user as never);
    const node = await this.nodes.get(service.nodeId.toString());
    const driveOwnerType = user.role === "customer" ? "customer" : "admin";
    const driveOwnerId = driveOwnerType === "customer" ? service.ownerId : undefined;
    const backup = await this.backups.create({
      serviceId: new Types.ObjectId(serviceId),
      ownerId: service.ownerId,
      requestedBy: new Types.ObjectId(user.id),
      driveOwnerType,
      ...(driveOwnerId ? { driveOwnerId } : {}),
      destination,
      status: "running",
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
    try {
      // Agent creates tar.zst, computes sha256, reports back.
      const result = await this.nodes.agentCall(node, "/backups/create", {
        serviceId,
        backupId: backup._id!.toString(),
      }, "POST", 10 * 60 * 1000);
      backup.sizeBytes = result.sizeBytes;
      backup.checksum = result.checksum;
      if (destination === "gdrive") {
        const archive = await this.nodes.downloadBackupArchive(node, serviceId, backup._id!.toString());
        if (!this.verifyChecksum(archive, result.checksum)) throw new BadRequestException("Downloaded archive failed checksum verification");
        const ownerRecord = await this.backups.db.collection("users").findOne(
          { _id: service.ownerId },
          { projection: { displayName: 1, username: 1, email: 1 } },
        );
        const ownerName = String(ownerRecord?.displayName || ownerRecord?.username || ownerRecord?.email || service.ownerId.toString());
        const encrypted = this.encryptArchive(archive);
        backup.encryptionMetadata = encrypted.metadata;
        backup.manifest = { ...(backup.manifest ?? {}), encryption: encrypted.metadata, archiveChecksum: result.checksum };
        backup.remoteFileId = await this.uploadGoogleDriveArchive(
          encrypted.data,
          `nimbus-${serviceId}-${backup._id!.toString()}.tar.zst`,
          driveOwnerType,
          driveOwnerId?.toString(),
          service.type,
          service.name,
          ownerName,
          service.ownerId.toString(),
          backup._id!.toString(),
          result.checksum,
        );
        backup.verificationStatus = "verified";
      }
      if (destination !== "gdrive") backup.verificationStatus = "verified";
      backup.status = "completed";
      backup.completedAt = new Date();
    } catch (err) {
      backup.status = "failed";
      backup.verificationStatus = "failed";
      backup.error = (err as Error).message;
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
    let archive: Buffer;
    if (backup.remoteFileId) {
      const ownerType = backup.driveOwnerType ?? "admin";
      const ownerId = ownerType === "customer" ? backup.driveOwnerId?.toString() : undefined;
      const accessToken = await this.integrations.googleDriveAccessToken(ownerType, ownerId);
      const response = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.remoteFileId)}?alt=media`,
        { headers: { authorization: `Bearer ${accessToken}` }, responseType: "arraybuffer", maxContentLength: Infinity, timeout: 10 * 60 * 1000 },
      );
      const downloaded = Buffer.from(response.data);
      archive = backup.encryptionMetadata ? this.decryptArchive(downloaded, backup.encryptionMetadata) : downloaded;
    } else {
      archive = await this.nodes.downloadBackupArchive(node, service._id!.toString(), backupId);
    }
    if (!backup.checksum || !this.verifyChecksum(archive, backup.checksum)) {
      throw new BadRequestException("Backup integrity verification failed. Download was stopped.");
    }
    await this.audit.log({ actorId: user.id, action: "backups.download", targetType: "backup", targetId: backupId, sensitive: true });
    const safeName = service.name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "service";
    return { buffer: archive, filename: `nimbus-${safeName}-${backupId}.tar` };
  }

  async delete(backupId: string, user: { id: string; role: string }) {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
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

  /** Restore a verified archive only after explicit UI confirmation. */
  async restore(backupId: string, user: { id: string; role: string }, confirmed = false) {
    if (!confirmed) throw new BadRequestException("Explicit confirmation is required before restoring customer data");
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    if (backup.status !== "completed") throw new BadRequestException("Backup is not restorable");
    const service = await this.services.get(backup.serviceId.toString(), user as never);
    const node = await this.nodes.get(service.nodeId.toString());

    if (backup.remoteFileId) {
      const ownerType = backup.driveOwnerType ?? "admin";
      const ownerId = ownerType === "customer" ? backup.driveOwnerId?.toString() : undefined;
      const accessToken = await this.integrations.googleDriveAccessToken(ownerType, ownerId);
      let downloaded: Buffer;
      try {
        const response = await axios.get(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.remoteFileId)}?alt=media`,
          { headers: { authorization: `Bearer ${accessToken}` }, responseType: "arraybuffer", maxContentLength: Infinity, timeout: 10 * 60 * 1000 },
        );
        downloaded = Buffer.from(response.data);
      } catch (error) {
        const details = axios.isAxiosError(error) ? (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message : undefined;
        throw new BadRequestException(details ?? "Could not download this backup from Google Drive");
      }
      const archive = backup.encryptionMetadata ? this.decryptArchive(downloaded, backup.encryptionMetadata) : downloaded;
      if (!backup.checksum || !this.verifyChecksum(archive, backup.checksum)) {
        throw new BadRequestException("Backup integrity verification failed. The service was not changed.");
      }
      await this.nodes.uploadBackupArchive(node, service._id!.toString(), backupId, archive, backup.checksum);
    } else if (!backup.checksum) {
      throw new BadRequestException("This backup has no integrity checksum and cannot be safely restored");
    }

    // Keep a fresh node-local safety snapshot before replacing service data.
    const safetyBackup = await this.create(service._id!.toString(), user, "pre-restore", "local", true);
    if (safetyBackup.status !== "completed") {
      throw new BadRequestException("Could not create a safety backup. The existing service data was not changed.");
    }

    const restoreRequest = { serviceId: service._id!.toString(), backupId };
    await this.nodes.agentCall(node, "/backups/restore", restoreRequest, "POST", 10 * 60 * 1000);
    await this.nodes.agentCall(node, "/backups/restore-commit", restoreRequest, "POST", 10 * 60 * 1000);
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

  private async uploadGoogleDriveArchive(
    archive: Buffer,
    filename: string,
    ownerType: "admin" | "customer",
    ownerId: string | undefined,
    serviceType: string,
    serviceName: string,
    customerFolderName: string,
    customerId: string,
    backupId: string,
    checksum: string,
  ): Promise<string> {
    const accessToken = await this.integrations.googleDriveAccessToken(ownerType, ownerId);
    const parentFolderId = await this.integrations.googleDriveBackupFolder(ownerType, customerId, serviceType, serviceName, customerFolderName);
    let metadata;
    try {
      metadata = await axios.post(
        "https://www.googleapis.com/drive/v3/files?fields=id,name",
        {
          name: filename,
          mimeType: "application/octet-stream",
          parents: [parentFolderId],
          appProperties: { nimbusBackupId: backupId, nimbusServiceId: filename.split("-")[1] ?? "", nimbusCustomerId: customerId, nimbusSha256: checksum },
        },
        { headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" } },
      );
    } catch (error) {
      const details = axios.isAxiosError(error) ? (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message : undefined;
      throw new BadRequestException(details ?? "Google Drive could not create the backup file. Check the connected Google account and Drive permissions.");
    }
    const fileId = metadata.data?.id as string | undefined;
    if (!fileId) throw new BadRequestException("Google Drive did not create a backup file");
    try {
      await axios.patch(
        `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
        archive,
        {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/octet-stream",
            "content-length": String(archive.length),
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 10 * 60 * 1000,
        },
      );
      const downloaded = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          responseType: "arraybuffer",
          maxContentLength: Infinity,
          timeout: 10 * 60 * 1000,
        },
      );
      const uploadedBytes = Buffer.from(downloaded.data);
      const expectedDigest = createHash("sha256").update(archive).digest("hex");
      const actualDigest = createHash("sha256").update(uploadedBytes).digest("hex");
      if (expectedDigest !== actualDigest) throw new BadRequestException("Google Drive upload verification failed: downloaded content did not match the uploaded archive");
      return fileId;
    } catch (error) {
      await axios.delete(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      }).catch(() => undefined);
      const details = axios.isAxiosError(error) ? (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message : undefined;
      throw new BadRequestException(details ?? "Google Drive upload failed. Reconnect the shared Drive account and try again.");
    }
  }

  /** Integrity verification helper (sha256) usable by scheduled verification jobs. */
  verifyChecksum(buffer: Buffer, expected: string): boolean {
    const digest = createHash("sha256").update(buffer).digest();
    return digest.toString("base64") === expected || digest.toString("hex") === expected;
  }
}
