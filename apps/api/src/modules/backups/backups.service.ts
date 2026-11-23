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
import { Backup, BackupDocument } from "./backup.schema";
import { NodesService } from "../nodes/nodes.service";
import { ServicesService } from "../services/services.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { User, UserDocument } from "../users/user.schema";
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
      if (user.role === "customer") filter.driveOwnerType = "customer";
    } else if (!isStaffRole(user.role)) {
      const ownedServices = await this.services.listFor(user);
      const serviceIds = ownedServices.map((service) => service._id);
      if (serviceIds.length === 0) return [];
      filter.serviceId = { $in: serviceIds };
      filter.driveOwnerType = "customer";
    }
    return this.backups.find(filter).sort({ createdAt: -1 }).limit(100);
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
      if (destination === "gdrive") {
        const tempDir = await mkdtemp(join(tmpdir(), "nimbus-backup-"));
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
            await this.nodes.downloadBackupArchiveStream(node, serviceId, backup._id!.toString()),
            digestStream,
            createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
          );
          const digest = hash.digest();
          const downloadedInfo = await stat(archivePath);
          if (Number(result.sizeBytes) !== downloadedInfo.size) throw new BadRequestException("Downloaded archive size does not match the node manifest");
          if (digest.toString("base64") !== result.checksum && digest.toString("hex") !== result.checksum) {
            throw new BadRequestException("Downloaded archive failed checksum verification");
          }
          const encryptedPath = join(tempDir, `${backup._id!.toString()}.tar.enc`);
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
          backup.remoteFileId = await this.uploadGoogleDriveArchive(
            encryptedPath,
            `nimbus-${serviceId}-${backup._id!.toString()}.tar.enc`,
            driveOwner,
            { serviceId, serviceName: service.name, serviceType: String(service.type), customerName, customerId: service.ownerId.toString() },
          );
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
      backup.status = "completed";
      backup.completedAt = new Date();
    } catch (err) {
      backup.status = "failed";
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

  /** Restore into a staging dir — data is swapped only after verification. */
  async restore(backupId: string, user: AuthUser) {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    if (backup.status !== "completed") throw new BadRequestException("Backup is not restorable");
    const service = await this.services.get(backup.serviceId.toString(), user as never);
    if (user.role === "customer" && backup.driveOwnerType !== "customer") throw new NotFoundException("Backup not found");
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
    }) as { status?: string; checksumVerified?: boolean; safetyBackupId?: string; safetyBackupChecksum?: string };
    if (result.status !== "restored" || result.checksumVerified !== true) {
      throw new BadRequestException("Node Agent did not confirm a verified restore");
    }
    await this.audit.log({
      actorId: user.id,
      action: "backups.restore",
      targetId: backupId,
      detail: result.safetyBackupId ? `safetyBackupId=${result.safetyBackupId}; safetyChecksum=${result.safetyBackupChecksum ?? "unavailable"}` : "restore verified",
      sensitive: true,
    });
    return { ok: true, safetyBackupId: result.safetyBackupId ?? null };
  }

  async download(backupId: string, user: AuthUser): Promise<{ stream: import("node:stream").Readable; filename: string; sizeBytes?: number }> {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    const service = await this.services.get(backup.serviceId.toString(), user);
    if (user.role === "customer" && backup.driveOwnerType !== "customer") throw new NotFoundException("Backup not found");
    const filename = `nimbus-backup-${backupId}.tar`;
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
      if (backup.encryptionAlgorithm !== "aes-256-gcm") {
        return { stream: response.data as import("node:stream").Readable, filename, sizeBytes: backup.sizeBytes };
      }
      const tempDir = await mkdtemp(join(tmpdir(), "nimbus-download-"));
      const encryptedPath = join(tempDir, `${backupId}.tar.enc`);
      const archivePath = join(tempDir, `${backupId}.tar`);
      try {
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
          backup.checksum ?? "",
        );
        if (decryptedSize !== backup.sizeBytes) throw new BadRequestException("Decrypted archive size does not match its backup manifest");
        const stream = createReadStream(archivePath);
        const cleanup = () => { void rm(tempDir, { recursive: true, force: true }); };
        stream.once("close", cleanup);
        stream.once("error", cleanup);
        return { stream, filename, sizeBytes: decryptedSize };
      } catch (error) {
        await rm(tempDir, { recursive: true, force: true });
        throw error;
      }
    }
    const node = await this.nodes.get(service.nodeId.toString());
    return {
      stream: await this.nodes.downloadBackupArchiveStream(node, service._id!.toString(), backupId),
      filename,
      sizeBytes: backup.sizeBytes,
    };
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
    });
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
  ): Promise<string> {
    const accessToken = await this.integrations.googleDriveAccessToken(driveOwner);
    const archiveInfo = await stat(archivePath);
    if (!archiveInfo.isFile() || archiveInfo.size <= 0) throw new BadRequestException("Backup archive is empty or unavailable");
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

    let uploadUrl = "";
    try {
      const session = await axios.post(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id",
        { name: filename, mimeType: "application/octet-stream", parents: [serviceFolderId] },
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
      let fileId: string | undefined;
      let noProgressRetries = 0;
      const chunkSize = 8 * 1024 * 1024; // 8 MiB, a multiple of Google's 256 KiB chunk requirement.
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
      if (uploadUrl) await axios.delete(uploadUrl).catch(() => undefined);
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
