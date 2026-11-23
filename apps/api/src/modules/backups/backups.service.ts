import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import axios, { type AxiosResponse } from "axios";
import { AuditService } from "../audit/audit.service";
import { env } from "../../config/env";
import { Backup, type BackupDocument } from "./backup.schema";
import { NodesService } from "../nodes/nodes.service";
import { ServicesService } from "../services/services.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { User, type UserDocument } from "../users/user.schema";
import { isStaffRole, type AuthUser } from "../../common/auth.decorators";

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
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly nodes: NodesService,
    private readonly services: ServicesService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
  ) {}

  assertBackupEncryptionConfigured(): void {
    this.backupKey();
  }

  private backupKey(): Buffer {
    const configured = env.backupEncryptionKey;
    if (!/^[a-f0-9]{64}$/i.test(configured)) {
      throw new BadRequestException("Encrypted Drive backups are disabled until BACKUP_ENCRYPTION_KEY is set to 64 hexadecimal characters and escrowed outside this VPS");
    }
    return Buffer.from(configured, "hex");
  }

  private async encryptArchiveFile(inputPath: string, outputPath: string): Promise<{ iv: string; tag: string; sizeBytes: number }> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.backupKey(), iv);
    await pipeline(
      createReadStream(inputPath),
      cipher,
      createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
    );
    const info = await stat(outputPath);
    return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), sizeBytes: info.size };
  }

  private async decryptArchiveFile(
    inputPath: string,
    outputPath: string,
    ivHex: string,
    tagHex: string,
    expectedChecksum: string,
  ): Promise<number> {
    if (!/^[a-f0-9]{24}$/i.test(ivHex) || !/^[a-f0-9]{32}$/i.test(tagHex)) {
      throw new BadRequestException("Backup encryption metadata is invalid");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.backupKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const hash = createHash("sha256");
    const digestStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        createReadStream(inputPath),
        decipher,
        digestStream,
        createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
      );
    } catch {
      await rm(outputPath, { force: true }).catch(() => undefined);
      throw new BadRequestException("Backup decryption or authentication failed");
    }
    const digest = hash.digest();
    if (digest.toString("base64") !== expectedChecksum && digest.toString("hex") !== expectedChecksum) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      throw new BadRequestException("Decrypted backup failed SHA-256 verification");
    }
    return (await stat(outputPath)).size;
  }

  /**
   * Customers can only list backups belonging to services they currently own.
   * Staff retains the cross-customer view used by the admin backup screen.
   * Resolve service ownership through ServicesService so this also protects
   * legacy backup records created before ownerId was stored on the backup.
   */
  async list(user: AuthUser, serviceId?: string) {
    const filter: Record<string, unknown> = {};
    if (serviceId) {
      await this.services.get(serviceId, user); // ownership check
      filter.serviceId = new Types.ObjectId(serviceId);
      filter.driveOwnerType = user.role === "customer" ? "customer" : "admin";
    } else if (!isStaffRole(user.role)) {
      const ownedServices = await this.services.listFor(user);
      const serviceIds = ownedServices.map((service) => service._id);
      if (serviceIds.length === 0) return [];
      filter.serviceId = { $in: serviceIds };
      filter.driveOwnerType = "customer";
    } else {
      filter.driveOwnerType = "admin";
    }
    return this.backups.find(filter).sort({ createdAt: -1 }).limit(100);
  }

  async getDriveFolderUrl(user: AuthUser): Promise<{ url: string }> {
    const accessToken = await this.integrations.googleDriveAccessToken(user);
    const folderName = user.role === "customer" ? "NIMBUS Backups" : "NIMBUS Full Panel Backups";
    const folderId = await this.ensureDriveFolder(accessToken, folderName);
    return { url: `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}` };
  }

  async listForRetention(user: AuthUser, serviceId: string) {
    await this.services.get(serviceId, user);
    const filter: Record<string, unknown> = { serviceId: new Types.ObjectId(serviceId) };
    filter.driveOwnerType = user.role === "customer" ? "customer" : "admin";
    return this.backups.find(filter).sort({ createdAt: -1 }).limit(5000);
  }

  async create(serviceId: string, user: AuthUser, trigger: string, destination = "local") {
    const service = await this.services.get(serviceId, user);
    const node = await this.nodes.get(service.nodeId.toString());
    const backup = await this.backups.create({
      serviceId: new Types.ObjectId(serviceId),
      ownerId: service.ownerId,
      driveOwnerType: destination === "gdrive" ? (user.role === "customer" ? "customer" : "admin") : undefined,
      destination,
      status: "running",
      progress: 0,
      currentStep: "Preparing service snapshot",
      trigger,
      createdBy: new Types.ObjectId(user.id),
    });
    try {
      // Agent creates a plain tar archive and computes its SHA-256 checksum.
      const result = await this.nodes.agentCall(node, "/backups/create", {
        serviceId,
        backupId: backup._id!.toString(),
      }, "POST", 10 * 60 * 1000);
      backup.sizeBytes = result.sizeBytes;
      backup.checksum = result.checksum;
      backup.progress = 20;
      backup.currentStep = "Snapshot created";
      await backup.save();
      if (destination === "gdrive") {
        const tempDir = await mkdtemp(join(tmpdir(), "nimbus-backup-"));
        const archivePath = join(tempDir, `${backup._id!.toString()}.tar`);
        try {
          backup.currentStep = "Downloading archive from node";
          backup.progress = 30;
          await backup.save();
          const hash = createHash("sha256");
          const digestStream = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(
            await this.nodes.downloadBackupArchiveStream(node, serviceId, backup._id!.toString()),
            digestStream,
            createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
          );
          const digest = hash.digest();
          const downloadedInfo = await stat(archivePath);
          backup.currentStep = "Verifying archive checksum";
          backup.progress = 50;
          await backup.save();
          if (Number(result.sizeBytes) !== downloadedInfo.size) throw new BadRequestException("Downloaded archive size does not match the node manifest");
          if (digest.toString("base64") !== result.checksum && digest.toString("hex") !== result.checksum) {
            throw new BadRequestException("Downloaded archive failed checksum verification");
          }
          const encryptedPath = join(tempDir, `${backup._id!.toString()}.tar.enc`);
          backup.currentStep = "Encrypting archive";
          backup.progress = 60;
          await backup.save();
          const encrypted = await this.encryptArchiveFile(archivePath, encryptedPath);
          backup.encryptionAlgorithm = "aes-256-gcm";
          backup.encryptionIv = encrypted.iv;
          backup.encryptionTag = encrypted.tag;
          backup.storedSizeBytes = encrypted.sizeBytes;
          const driveOwner = user.role === "customer"
            ? { id: service.ownerId.toString(), role: "customer" as const }
            : user;
          const customer = await this.users.findById(service.ownerId).select("displayName username").lean();
          const customerName = customer?.displayName || customer?.username || "customer";
          backup.currentStep = "Uploading to Google Drive";
          backup.progress = 75;
          await backup.save();
          backup.remoteFileId = await this.uploadGoogleDriveArchive(
            encryptedPath,
            `nimbus-${serviceId}-${backup._id!.toString()}.tar.enc`,
            driveOwner,
            { serviceId, serviceName: service.name, serviceType: String(service.type), customerName, customerId: service.ownerId.toString() },
            async percent => {
              backup.progress = 75 + Math.round(percent * 0.2);
              backup.currentStep = "Uploading to Google Drive";
              await backup.save();
            },
          );
          backup.currentStep = "Verifying upload and cleaning node archive";
          backup.progress = 95;
          await backup.save();
          try {
            await this.nodes.agentCall(node, "/backups/delete", { serviceId, backupId: backup._id!.toString() });
          } catch {
            backup.localArchiveCleanupPending = true;
          }
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
      backup.status = "completed";
      backup.progress = 100;
      backup.currentStep = "Completed";
      backup.completedAt = new Date();
    } catch (err) {
      backup.status = "failed";
      backup.currentStep = "Failed";
      backup.error = (err as Error).message;
    }
    await backup.save();
    await this.audit.log({
      actorId: user.id,
      action: "backups.create",
      targetId: backup._id!.toString(),
      sensitive: true,
    }).catch(() => undefined);
    return backup;
  }

  /** Restore into a staging dir — data is swapped only after verification. */
  async restore(backupId: string, user: AuthUser) {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    if (backup.status !== "completed") throw new BadRequestException("Backup is not restorable");
    const service = await this.services.get(backup.serviceId.toString(), user);
    if (backup.driveOwnerType !== (user.role === "customer" ? "customer" : "admin")) throw new NotFoundException("Backup not found");
    const node = await this.nodes.get(service.nodeId.toString());
    if (!backup.checksum) throw new BadRequestException("Backup has no integrity checksum and cannot be restored safely");
    if (backup.destination === "gdrive") {
      if (!backup.remoteFileId || !backup.sizeBytes) throw new BadRequestException("Google Drive backup metadata is incomplete");
      const driveOwner = backup.driveOwnerType === "customer"
        ? { id: (backup.ownerId ?? service.ownerId).toString(), role: "customer" as const }
        : { id: user.id, role: user.role };
      const accessToken = await this.integrations.googleDriveAccessToken(driveOwner);
      const tempDir = await mkdtemp(join(tmpdir(), "nimbus-restore-"));
      const encryptedPath = join(tempDir, `${backupId}.tar.enc`);
      const archivePath = join(tempDir, `${backupId}.tar`);
      try {
        const remote = await axios.get(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.remoteFileId)}?alt=media`,
          {
            headers: { authorization: `Bearer ${accessToken}` },
            responseType: "stream",
            timeout: 10 * 60 * 1000,
            maxContentLength: Infinity,
          },
        );
        if (backup.encryptionAlgorithm === "aes-256-gcm") {
          await pipeline(remote.data, createWriteStream(encryptedPath, { flags: "wx", mode: 0o600 }));
          const encryptedInfo = await stat(encryptedPath);
          if (backup.storedSizeBytes && encryptedInfo.size !== backup.storedSizeBytes) {
            throw new BadRequestException("Encrypted Drive archive size does not match its backup manifest");
          }
          const decryptedSize = await this.decryptArchiveFile(
            encryptedPath,
            archivePath,
            backup.encryptionIv ?? "",
            backup.encryptionTag ?? "",
            backup.checksum,
          );
          if (decryptedSize !== backup.sizeBytes) throw new BadRequestException("Decrypted archive size does not match its backup manifest");
        } else {
          const hash = createHash("sha256");
          const digestStream = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(remote.data, digestStream, createWriteStream(archivePath, { flags: "wx", mode: 0o600 }));
          const digest = hash.digest();
          if (digest.toString("base64") !== backup.checksum && digest.toString("hex") !== backup.checksum) {
            throw new BadRequestException("Downloaded Drive archive failed SHA-256 verification");
          }
          if ((await stat(archivePath)).size !== backup.sizeBytes) {
            throw new BadRequestException("Downloaded archive size does not match its backup manifest");
          }
        }
        const uploaded = await this.nodes.uploadBackupArchiveStream(
          node,
          service._id!.toString(),
          backupId,
          backup.checksum,
          backup.sizeBytes,
          createReadStream(archivePath),
        );
        if (!uploaded.uploaded || uploaded.sizeBytes !== backup.sizeBytes) {
          throw new BadRequestException("Node Agent did not verify the downloaded Google Drive archive");
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
    const result = await this.nodes.agentCall(node, "/backups/restore", {
      serviceId: service._id!.toString(),
      backupId,
      checksum: backup.checksum,
    }) as { status?: string; checksumVerified?: boolean; safetyBackupId?: string; safetyBackupChecksum?: string; safetyBackupSizeBytes?: number };
    if (result.status !== "restored" || result.checksumVerified !== true) {
      throw new BadRequestException("Node Agent did not confirm a verified restore");
    }
    let safetyBackupRecord: BackupDocument | undefined;
    let safetyBackupError: string | undefined;
    if (result.safetyBackupId && result.safetyBackupChecksum && result.safetyBackupSizeBytes) {
      try {
        safetyBackupRecord = await this.persistSafetyBackup(
          node,
          service,
          user,
          result.safetyBackupId,
          result.safetyBackupChecksum,
          result.safetyBackupSizeBytes,
        );
      } catch (error) {
        safetyBackupError = error instanceof Error ? error.message : "Safety backup upload failed";
      }
    } else {
      safetyBackupError = "Node Agent did not return complete safety backup metadata";
    }
    await this.nodes.agentCall(node, "/backups/delete", {
      serviceId: service._id!.toString(),
      backupId,
    }).catch(() => undefined);
    await this.audit.log({
      actorId: user.id,
      action: "backups.restore",
      targetId: backupId,
      detail: safetyBackupRecord
        ? `safetyBackupRecordId=${safetyBackupRecord._id!.toString()}; source=${result.safetyBackupId}`
        : `restore verified; safety backup remains on node or needs attention: ${safetyBackupError ?? "unknown"}`,
      sensitive: true,
    }).catch(() => undefined);
    return {
      ok: true,
      safetyBackupId: safetyBackupRecord?._id?.toString() ?? result.safetyBackupId ?? null,
      safetyBackupStored: Boolean(safetyBackupRecord),
      safetyBackupError,
    };
  }

  private async persistSafetyBackup(
    node: Awaited<ReturnType<NodesService["get"]>>,
    service: Awaited<ReturnType<ServicesService["get"]>>,
    user: AuthUser,
    safetyBackupId: string,
    checksum: string,
    sizeBytes: number,
  ): Promise<BackupDocument> {
    const backup = await this.backups.create({
      serviceId: service._id,
      ownerId: service.ownerId,
      driveOwnerType: user.role === "customer" ? "customer" : "admin",
      destination: "gdrive",
      status: "running",
      trigger: "pre-restore-safety",
      createdBy: new Types.ObjectId(user.id),
    });
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-safety-backup-"));
    const archivePath = join(tempDir, `${backup._id!.toString()}.tar`);
    try {
      const hash = createHash("sha256");
      const digestStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        await this.nodes.downloadBackupArchiveStream(node, service._id!.toString(), safetyBackupId),
        digestStream,
        createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
      );
      const digest = hash.digest();
      const archiveInfo = await stat(archivePath);
      if (archiveInfo.size !== sizeBytes ||
        (digest.toString("base64") !== checksum && digest.toString("hex") !== checksum)) {
        throw new BadRequestException("Pre-restore safety archive failed integrity verification");
      }
      const encryptedPath = join(tempDir, `${backup._id!.toString()}.tar.enc`);
      const encrypted = await this.encryptArchiveFile(archivePath, encryptedPath);
      backup.sizeBytes = sizeBytes;
      backup.checksum = checksum;
      backup.encryptionAlgorithm = "aes-256-gcm";
      backup.encryptionIv = encrypted.iv;
      backup.encryptionTag = encrypted.tag;
      backup.storedSizeBytes = encrypted.sizeBytes;
      const customer = await this.users.findById(service.ownerId).select("displayName username").lean();
      const driveOwner = user.role === "customer"
        ? { id: service.ownerId.toString(), role: "customer" as const }
        : user;
      backup.remoteFileId = await this.uploadGoogleDriveArchive(
        encryptedPath,
        `nimbus-${service._id!.toString()}-${backup._id!.toString()}-safety.tar.enc`,
        driveOwner,
        {
          serviceId: service._id!.toString(),
          serviceName: service.name,
          serviceType: String(service.type),
          customerName: customer?.displayName || customer?.username || "customer",
          customerId: service.ownerId.toString(),
        },
      );
      backup.status = "completed";
      backup.completedAt = new Date();
      await backup.save();
      await this.nodes.agentCall(node, "/backups/delete", {
        serviceId: service._id!.toString(),
        backupId: safetyBackupId,
      }).catch(() => { backup.localArchiveCleanupPending = true; });
      await backup.save();
      await this.audit.log({
        actorId: user.id,
        action: "backups.safety.create",
        targetId: backup._id!.toString(),
        detail: `sourceRestoreId=${safetyBackupId}`,
        sensitive: true,
      }).catch(() => undefined);
      return backup;
    } catch (error) {
      backup.status = "failed";
      backup.error = error instanceof Error ? error.message : "Pre-restore safety backup failed";
      await backup.save();
      throw error;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async retryUpload(backupId: string, user: AuthUser) {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    const service = await this.services.get(backup.serviceId.toString(), user);
    if (backup.driveOwnerType !== (user.role === "customer" ? "customer" : "admin")) throw new NotFoundException("Backup not found");
    if (backup.destination !== "gdrive" || backup.status !== "failed" || backup.remoteFileId || !backup.checksum || !backup.sizeBytes) {
      throw new BadRequestException("This backup does not have a preserved source archive that can be retried");
    }
    this.assertBackupEncryptionConfigured();
    const node = await this.nodes.get(service.nodeId.toString());
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-backup-retry-"));
    const archivePath = join(tempDir, `${backupId}.tar`);
    const encryptedPath = join(tempDir, `${backupId}.tar.enc`);
    try {
      const hash = createHash("sha256");
      const digestStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      backup.currentStep = "Rechecking preserved node archive";
      backup.progress = 10;
      await backup.save();
      await pipeline(
        await this.nodes.downloadBackupArchiveStream(node, service._id!.toString(), backupId),
        digestStream,
        createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
      );
      const digest = hash.digest();
      const archiveInfo = await stat(archivePath);
      if (archiveInfo.size !== backup.sizeBytes ||
        (digest.toString("base64") !== backup.checksum && digest.toString("hex") !== backup.checksum)) {
        throw new BadRequestException("Preserved node archive failed SHA-256 verification");
      }
      backup.currentStep = "Encrypting preserved archive";
      backup.progress = 35;
      await backup.save();
      const encrypted = await this.encryptArchiveFile(archivePath, encryptedPath);
      const customer = await this.users.findById(service.ownerId).select("displayName username").lean();
      const driveOwner = user.role === "customer"
        ? { id: service.ownerId.toString(), role: "customer" as const }
        : user;
      backup.currentStep = "Retrying Google Drive upload";
      backup.progress = 50;
      await backup.save();
      backup.remoteFileId = await this.uploadGoogleDriveArchive(
        encryptedPath,
        `nimbus-${service._id!.toString()}-${backupId}.tar.enc`,
        driveOwner,
        {
          serviceId: service._id!.toString(),
          serviceName: service.name,
          serviceType: String(service.type),
          customerName: customer?.displayName || customer?.username || "customer",
          customerId: service.ownerId.toString(),
        },
        async percent => {
          backup.progress = 50 + Math.round(percent * 0.45);
          backup.currentStep = "Uploading to Google Drive";
          await backup.save();
        },
      );
      backup.encryptionAlgorithm = "aes-256-gcm";
      backup.encryptionIv = encrypted.iv;
      backup.encryptionTag = encrypted.tag;
      backup.storedSizeBytes = encrypted.sizeBytes;
      backup.status = "completed";
      backup.progress = 100;
      backup.currentStep = "Completed";
      backup.completedAt = new Date();
      backup.error = undefined;
      await backup.save();
      await this.nodes.agentCall(node, "/backups/delete", { serviceId: service._id!.toString(), backupId }).catch(() => {
        backup.localArchiveCleanupPending = true;
        return backup.save();
      });
      await this.audit.log({ actorId: user.id, action: "backups.retry-upload", targetId: backupId, sensitive: true }).catch(() => undefined);
      return backup;
    } catch (error) {
      backup.status = "failed";
      backup.currentStep = "Upload retry failed";
      backup.error = error instanceof Error ? error.message : "Backup upload retry failed";
      await backup.save();
      throw error;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async download(backupId: string, user: AuthUser): Promise<{ stream: import("node:stream").Readable; filename: string; sizeBytes?: number }> {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    const service = await this.services.get(backup.serviceId.toString(), user);
    if (backup.driveOwnerType !== (user.role === "customer" ? "customer" : "admin")) throw new NotFoundException("Backup not found");
    if (!backup.checksum || !backup.sizeBytes) throw new BadRequestException("Backup integrity metadata is incomplete");

    const node = await this.nodes.get(service.nodeId.toString());
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-download-"));
    const encryptedPath = join(tempDir, `${backupId}.tar.enc`);
    const archivePath = join(tempDir, `${backupId}.tar`);
    try {
      if (backup.destination === "gdrive") {
        if (!backup.remoteFileId) throw new BadRequestException("Backup has no Google Drive file reference");
        const driveOwner = backup.driveOwnerType === "customer"
          ? { id: (backup.ownerId ?? service.ownerId).toString(), role: "customer" as const }
          : { id: user.id, role: user.role };
        const accessToken = await this.integrations.googleDriveAccessToken(driveOwner);
        const response = await axios.get(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.remoteFileId)}?alt=media`,
          {
            headers: { authorization: `Bearer ${accessToken}` },
            responseType: "stream",
            timeout: 10 * 60 * 1000,
            maxContentLength: Infinity,
          },
        );
        if (backup.encryptionAlgorithm === "aes-256-gcm") {
          await pipeline(response.data, createWriteStream(encryptedPath, { flags: "wx", mode: 0o600 }));
          const encryptedInfo = await stat(encryptedPath);
          if (backup.storedSizeBytes && encryptedInfo.size !== backup.storedSizeBytes) {
            throw new BadRequestException("Encrypted Drive archive size does not match its backup manifest");
          }
          const decryptedSize = await this.decryptArchiveFile(
            encryptedPath,
            archivePath,
            backup.encryptionIv ?? "",
            backup.encryptionTag ?? "",
            backup.checksum,
          );
          if (decryptedSize !== backup.sizeBytes) throw new BadRequestException("Decrypted archive size does not match its backup manifest");
        } else {
          const hash = createHash("sha256");
          const digestStream = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(response.data, digestStream, createWriteStream(archivePath, { flags: "wx", mode: 0o600 }));
          const digest = hash.digest();
          if (digest.toString("base64") !== backup.checksum && digest.toString("hex") !== backup.checksum) {
            throw new BadRequestException("Downloaded Drive archive failed SHA-256 verification");
          }
          if ((await stat(archivePath)).size !== backup.sizeBytes) throw new BadRequestException("Downloaded archive size does not match its manifest");
        }
      } else {
        const hash = createHash("sha256");
        const digestStream = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          await this.nodes.downloadBackupArchiveStream(node, service._id!.toString(), backupId),
          digestStream,
          createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
        );
        const digest = hash.digest();
        if (digest.toString("base64") !== backup.checksum && digest.toString("hex") !== backup.checksum) {
          throw new BadRequestException("Node backup failed SHA-256 verification");
        }
        if ((await stat(archivePath)).size !== backup.sizeBytes) throw new BadRequestException("Node backup size does not match its manifest");
      }

      const stream = createReadStream(archivePath);
      const cleanup = () => { void rm(tempDir, { recursive: true, force: true }); };
      stream.once("close", cleanup);
      stream.once("error", cleanup);
      return { stream, filename: `nimbus-backup-${backupId}.tar`, sizeBytes: backup.sizeBytes };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async delete(backupId: string, user: AuthUser) {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    const service = await this.services.get(backup.serviceId.toString(), user);
    if (user.role === "customer" && backup.driveOwnerType !== "customer") throw new NotFoundException("Backup not found");

    if (backup.destination === "gdrive" && backup.remoteFileId) {
      const driveOwner = backup.driveOwnerType === "customer"
        ? { id: (backup.ownerId ?? service.ownerId).toString(), role: "customer" as const }
        : { id: user.id, role: user.role };
      const accessToken = await this.integrations.googleDriveAccessToken(driveOwner);
      await axios.delete(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.remoteFileId)}`,
        { headers: { authorization: `Bearer ${accessToken}` }, timeout: 30_000 },
      );
    }

    const node = await this.nodes.get(service.nodeId.toString());
    await this.nodes.agentCall(node, "/backups/delete", {
      serviceId: service._id!.toString(),
      backupId,
    }).catch(() => undefined);
    await backup.deleteOne();
    await this.audit.log({
      actorId: user.id,
      action: "backups.delete",
      targetId: backupId,
      sensitive: true,
    }).catch(() => undefined);
    return { deleted: true };
  }

  private async ensureDriveFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
    const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const query = new URLSearchParams({
      q: `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${parentId}' in parents` : ""}`,
      fields: "files(id,name)",
      pageSize: "100",
    });
    const headers = { authorization: `Bearer ${accessToken}` };
    const existing = await axios.get(`https://www.googleapis.com/drive/v3/files?${query.toString()}`, { headers });
    const folders = existing.data?.files as Array<{ id?: string }> | undefined;
    if (folders?.[0]?.id) return folders[0].id;
    const created = await axios.post(
      "https://www.googleapis.com/drive/v3/files?fields=id,name",
      { name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) },
      { headers: { ...headers, "content-type": "application/json" } },
    );
    const id = created.data?.id as string | undefined;
    if (!id) throw new BadRequestException("Google Drive could not create a backup folder");
    return id;
  }

  private safeFolderName(value: string): string {
    return value.replace(/[\\\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "Unnamed";
  }

  private async uploadGoogleDriveArchive(
    archivePath: string,
    filename: string,
    driveOwner: Pick<AuthUser, "id" | "role">,
    service: { serviceId: string; serviceName: string; serviceType: string; customerName: string; customerId: string },
    onProgress?: (percent: number) => Promise<void>,
  ): Promise<string> {
    const accessToken = await this.integrations.googleDriveAccessToken(driveOwner);
    const rootName = driveOwner.role === "customer" ? "NIMBUS Backups" : "NIMBUS Full Panel Backups";
    const rootId = await this.ensureDriveFolder(accessToken, rootName);
    let parentId = rootId;
    if (driveOwner.role !== "customer") {
      const usersFolderId = await this.ensureDriveFolder(accessToken, "Users", rootId);
      parentId = await this.ensureDriveFolder(
        accessToken,
        `${this.safeFolderName(service.customerName)}_${service.customerId}`,
        usersFolderId,
      );
    }
    const categoryId = await this.ensureDriveFolder(accessToken, this.safeFolderName(service.serviceType), parentId);
    const serviceFolderId = await this.ensureDriveFolder(
      accessToken,
      `${this.safeFolderName(service.serviceName)}_${service.serviceId}`,
      categoryId,
    );
    return this.uploadResumableFile(accessToken, archivePath, filename, serviceFolderId, onProgress);
  }

  async uploadAdminPanelArtifact(
    inputPath: string,
    filename: string,
    folderSegments: string[],
    actor: AuthUser,
  ): Promise<{ fileId: string; checksum: string; encryptionIv: string; encryptionTag: string; sizeBytes: number; storedSizeBytes: number }> {
    if (actor.role !== "owner" && actor.role !== "admin") throw new BadRequestException("Only Admins can upload panel backup artifacts");
    const accessToken = await this.integrations.googleDriveAccessToken(actor);
    const rootId = await this.ensureDriveFolder(accessToken, "NIMBUS Full Panel Backups");
    let parentId = rootId;
    for (const segment of folderSegments) {
      parentId = await this.ensureDriveFolder(accessToken, this.safeFolderName(segment), parentId);
    }
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-panel-backup-"));
    const encryptedPath = join(tempDir, `${randomBytes(8).toString("hex")}.enc`);
    try {
      const checksum = await this.checksumArchiveFile(inputPath);
      const encryption = await this.encryptArchiveFile(inputPath, encryptedPath);
      const fileId = await this.uploadResumableFile(accessToken, encryptedPath, `${this.safeFolderName(filename)}.enc`, parentId);
      return {
        fileId,
        checksum: checksum.checksum,
        encryptionIv: encryption.iv,
        encryptionTag: encryption.tag,
        sizeBytes: checksum.sizeBytes,
        storedSizeBytes: encryption.sizeBytes,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async downloadAdminPanelArtifact(
    fileId: string,
    metadata: { checksum: string; encryptionIv: string; encryptionTag: string; sizeBytes: number; storedSizeBytes: number },
    actor: AuthUser,
    outputPath: string,
  ): Promise<void> {
    if (actor.role !== "owner" && actor.role !== "admin") throw new BadRequestException("Only Admins can download panel backup artifacts");
    const accessToken = await this.integrations.googleDriveAccessToken(actor);
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-panel-restore-artifact-"));
    const encryptedPath = join(tempDir, "artifact.enc");
    try {
      const response = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          responseType: "stream",
          timeout: 30 * 60 * 1000,
          maxContentLength: Infinity,
        },
      );
      await pipeline(response.data, createWriteStream(encryptedPath, { flags: "wx", mode: 0o600 }));
      const encryptedInfo = await stat(encryptedPath);
      if (encryptedInfo.size !== metadata.storedSizeBytes) throw new BadRequestException("Encrypted panel artifact size does not match its manifest");
      const decryptedSize = await this.decryptArchiveFile(
        encryptedPath,
        outputPath,
        metadata.encryptionIv,
        metadata.encryptionTag,
        metadata.checksum,
      );
      if (decryptedSize !== metadata.sizeBytes) throw new BadRequestException("Decrypted panel artifact size does not match its manifest");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async checksumArchiveFile(filePath: string): Promise<{ checksum: string; sizeBytes: number }> {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of createReadStream(filePath)) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(data);
      sizeBytes += data.length;
    }
    return { checksum: hash.digest("base64"), sizeBytes };
  }

  private async uploadResumableFile(accessToken: string, archivePath: string, filename: string, parentFolderId: string, onProgress?: (percent: number) => Promise<void>): Promise<string> {
    const archiveInfo = await stat(archivePath);
    if (!archiveInfo.isFile() || archiveInfo.size <= 0) throw new BadRequestException("Backup archive is empty or unavailable");
    let uploadUrl = "";
    let fileId: string | undefined;
    try {
      const session = await axios.post(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id",
        { name: filename, mimeType: "application/octet-stream", parents: [parentFolderId] },
        {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "x-upload-content-type": "application/octet-stream",
            "x-upload-content-length": String(archiveInfo.size),
          },
          timeout: 30_000,
        },
      );
      uploadUrl = session.headers.location as string;
      if (!uploadUrl) throw new BadRequestException("Google Drive did not return a resumable upload session");

      const file = await open(archivePath, "r");
      let offset = 0;
      let noProgressRetries = 0;
      const chunkSize = 8 * 1024 * 1024;
      try {
        while (offset < archiveInfo.size) {
          const length = Math.min(chunkSize, archiveInfo.size - offset);
          const chunk = Buffer.allocUnsafe(length);
          const read = await file.read(chunk, 0, length, offset);
          if (read.bytesRead !== length) throw new BadRequestException("Could not read the complete backup archive for upload");
          const end = offset + length - 1;
          let response: AxiosResponse;
          let attempt = 0;
          while (true) {
            try {
              response = await axios.put(uploadUrl, chunk, {
                headers: {
                  authorization: `Bearer ${accessToken}`,
                  "content-type": "application/octet-stream",
                  "content-length": String(length),
                  "content-range": `bytes ${offset}-${end}/${archiveInfo.size}`,
                },
                maxBodyLength: Infinity,
                timeout: 120_000,
                validateStatus: status => status === 308 || status === 200 || status === 201,
              });
              break;
            } catch (error) {
              const status = axios.isAxiosError(error) ? error.response?.status : undefined;
              const retryable = !status || status === 429 || status >= 500;
              if (!retryable || attempt >= 5) throw error;
              await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
              attempt += 1;
            }
          }
          if (response.status === 200 || response.status === 201) {
            fileId = (response.data as { id?: string })?.id;
            offset = archiveInfo.size;
            await onProgress?.(100);
            break;
          }
          const acknowledged = String(response.headers.range ?? "").match(/-(\d+)$/);
          if (acknowledged) {
            const nextOffset = Number(acknowledged[1]) + 1;
            if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > archiveInfo.size) {
              throw new BadRequestException("Google Drive returned an invalid upload progress range");
            }
            offset = nextOffset;
            noProgressRetries = 0;
            await onProgress?.(Math.min(100, Math.round((offset / archiveInfo.size) * 100)));
          } else {
            noProgressRetries += 1;
            if (noProgressRetries > 5) throw new BadRequestException("Google Drive upload made no progress after repeated retries");
            await new Promise(resolve => setTimeout(resolve, 500 * (2 ** (noProgressRetries - 1))));
          }
        }
      } finally {
        await file.close();
      }
      if (!fileId) throw new BadRequestException("Google Drive did not confirm completion of the backup upload");
      const verified = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,trashed`,
        { headers: { authorization: `Bearer ${accessToken}` }, timeout: 30_000 },
      );
      if (verified.data?.id !== fileId || verified.data?.name !== filename || Number(verified.data?.size) !== archiveInfo.size || verified.data?.trashed) {
        throw new BadRequestException("Google Drive upload verification failed");
      }
      return fileId;
    } catch (error) {
      if (fileId) await axios.delete(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { headers: { authorization: `Bearer ${accessToken}` } }).catch(() => undefined);
      else if (uploadUrl) await axios.delete(uploadUrl).catch(() => undefined);
      if (error instanceof BadRequestException) throw error;
      const details = axios.isAxiosError(error)
        ? (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message
        : undefined;
      throw new BadRequestException(details ?? "Google Drive resumable upload failed. Preserve the local backup and retry.");
    }
  }

  /** Integrity verification helper (sha256) usable by scheduled verification jobs. */
  verifyChecksum(buffer: Buffer, expected: string): boolean {
    const digest = createHash("sha256").update(buffer).digest();
    return digest.toString("base64") === expected || digest.toString("hex") === expected;
  }
}
