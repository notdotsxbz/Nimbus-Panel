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
    const filter: Record<string, unknown> = serviceId ? { serviceId } : {};
    if (serviceId) await this.services.get(serviceId, user as never); // ownership check
    return this.backups.find(filter).sort({ createdAt: -1 }).limit(100);
  }

  async create(serviceId: string, user: { id: string; role: string }, trigger: string, destination = "local") {
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
    const node = await this.nodes.get(service.nodeId.toString());
    await this.nodes.agentCall(node, "/backups/restore", {
      serviceId: service._id!.toString(),
      backupId,
    });
    await this.audit.log({ actorId: user.id, action: "backups.restore", targetId: backupId, sensitive: true });
    return { ok: true };
  }

  private async uploadGoogleDriveArchive(archive: Buffer, filename: string): Promise<string> {
    const accessToken = await this.integrations.googleDriveAccessToken();
    let metadata;
    try {
      metadata = await axios.post(
        "https://www.googleapis.com/drive/v3/files?fields=id,name",
        { name: filename, mimeType: "application/octet-stream" },
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
