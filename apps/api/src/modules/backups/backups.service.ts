import { createHash } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import axios from "axios";
import { AuditService } from "../audit/audit.service";
import { Backup, BackupDocument } from "./backup.schema";
import { NodesService } from "../nodes/nodes.service";
import { ServicesService } from "../services/services.service";
import { IntegrationsService } from "../integrations/integrations.service";

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
    if (serviceId) {
      const service = await this.services.get(serviceId, user as never);
      return this.backups.find({ serviceId: service._id }).sort({ createdAt: -1 }).limit(100);
    }
    // Derive the allowed service IDs from the ownership-enforced service query.
    // Never return all customers' backup metadata to a customer.
    const visibleServices = await this.services.listFor(user as never);
    const allowedIds = visibleServices.map((service) => service._id);
    return this.backups.find({ serviceId: { $in: allowedIds } }).sort({ createdAt: -1 }).limit(100);
  }

  async create(serviceId: string, user: { id: string; role: string }, trigger: string, destination = "local") {
    if (!["local", "gdrive"].includes(destination)) throw new BadRequestException("Unsupported backup destination");
    const service = await this.services.get(serviceId, user as never);
    const node = await this.nodes.get(service.nodeId.toString());
    const backup = await this.backups.create({
      serviceId: new Types.ObjectId(serviceId),
      destination,
      status: "running",
      trigger,
      createdBy: new Types.ObjectId(user.id),
    });
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
        backup.remoteFileId = await this.uploadGoogleDriveArchive(
          archive,
          `nimbus-${serviceId}-${backup._id!.toString()}.tar.zst`,
        );
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
  async restore(backupId: string, user: { id: string; role: string }) {
    const backup = await this.backups.findById(backupId);
    if (!backup) throw new NotFoundException("Backup not found");
    if (backup.status !== "completed") throw new BadRequestException("Backup is not restorable");
    const service = await this.services.get(backup.serviceId.toString(), user as never);
    // Remote archives are not currently downloaded back to the agent. Never
    // silently restore a possibly unrelated local archive with the same ID.
    if (backup.destination !== "local") {
      throw new BadRequestException("Remote backup restoration is unavailable until verified archive retrieval is implemented");
    }
    const node = await this.nodes.get(service.nodeId.toString());
    await this.nodes.agentCall(node, "/backups/restore", {
      serviceId: service._id!.toString(),
      backupId,
    });
    await this.audit.log({ actorId: user.id, action: "backups.restore", targetId: backupId, sensitive: true });
    return { ok: true };
  }

  /** Google Drive resumable upload. Drive requires chunks in multiples of 256 KiB. */
  private async uploadGoogleDriveArchive(archive: Buffer, filename: string): Promise<string> {
    const token = await this.integrations.googleDriveAccessToken();
    const initiation = await axios.post(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size",
      { name: filename, mimeType: "application/octet-stream" },
      {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": "application/octet-stream",
          "x-upload-content-length": String(archive.length),
        },
        timeout: 30_000,
      },
    );
    const session = initiation.headers.location as string | undefined;
    if (!session || !session.startsWith("https://www.googleapis.com/upload/drive/")) {
      throw new BadRequestException("Google Drive did not return a valid resumable upload session");
    }
    const chunkSize = 8 * 1024 * 1024;
    let offset = 0;
    let attempts = 0;
    while (offset < archive.length || (archive.length === 0 && offset === 0)) {
      const end = Math.min(offset + chunkSize, archive.length);
      const chunk = archive.subarray(offset, end);
      try {
        const response = await axios.put(session, chunk, {
          headers: {
            authorization: `Bearer ${await this.integrations.googleDriveAccessToken()}`,
            "content-type": "application/octet-stream",
            "content-length": String(chunk.length),
            "content-range": archive.length
              ? `bytes ${offset}-${end - 1}/${archive.length}`
              : "bytes */0",
          },
          maxBodyLength: Infinity,
          timeout: 120_000,
          validateStatus: (status) => status === 308 || (status >= 200 && status < 300),
        });
        if (response.status !== 308) {
          const fileId = response.data?.id as string | undefined;
          if (!fileId) throw new BadRequestException("Google Drive upload finished without a file ID");
          if (Number(response.data?.size) !== archive.length) {
            throw new BadRequestException("Google Drive uploaded size does not match the archive");
          }
          return fileId;
        }
        const range = String(response.headers.range ?? "");
        const match = /^bytes=0-(\\d+)$/.exec(range);
        offset = match ? Number(match[1]) + 1 : 0;
        if (offset > archive.length) throw new BadRequestException("Google Drive returned an invalid upload offset");
        attempts = 0;
      } catch (error) {
        if (++attempts > 5) throw error;
        // Query committed bytes rather than assuming a failed request wrote nothing.
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempts, 15_000)));
        const status = await axios.put(session, Buffer.alloc(0), {
          headers: {
            authorization: `Bearer ${await this.integrations.googleDriveAccessToken()}`,
            "content-length": "0",
            "content-range": `bytes */${archive.length}`,
          },
          timeout: 30_000,
          validateStatus: (code) => code === 308 || (code >= 200 && code < 300),
        });
        if (status.status !== 308) {
          const fileId = status.data?.id as string | undefined;
          if (fileId && Number(status.data?.size) === archive.length) return fileId;
          throw new BadRequestException("Google Drive returned an unexpected upload completion response");
        }
        const match = /^bytes=0-(\\d+)$/.exec(String(status.headers.range ?? ""));
        offset = match ? Number(match[1]) + 1 : 0;
      }
    }
    throw new BadRequestException("Google Drive upload did not complete");
  }

  /** Integrity verification helper (sha256) usable by scheduled verification jobs. */
  verifyChecksum(buffer: Buffer, expected: string): boolean {
    const digest = createHash("sha256").update(buffer).digest();
    return digest.toString("base64") === expected || digest.toString("hex") === expected;
  }
}
