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
    private readonly nodes: NodesService,
    private readonly services: ServicesService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
  ) {}

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
    } else if (!isStaffRole(user.role)) {
      const ownedServices = await this.services.listFor(user);
      const serviceIds = ownedServices.map((service) => service._id);
      if (serviceIds.length === 0) return [];
      filter.serviceId = { $in: serviceIds };
    }
    return this.backups.find(filter).sort({ createdAt: -1 }).limit(100);
  }

  async create(serviceId: string, user: AuthUser, trigger: string, destination = "local") {
    const service = await this.services.get(serviceId, user);
    const node = await this.nodes.get(service.nodeId.toString());
    const backup = await this.backups.create({
      serviceId: new Types.ObjectId(serviceId),
      ownerId: service.ownerId,
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
        const driveOwner = user.role === "customer"
          ? { id: service.ownerId.toString(), role: "customer" as const }
          : user;
        backup.remoteFileId = await this.uploadGoogleDriveArchive(
          archive,
          `nimbus-${serviceId}-${backup._id!.toString()}.tar.zst`,
          driveOwner,
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
  async restore(backupId: string, user: AuthUser) {
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

  private async uploadGoogleDriveArchive(archive: Buffer, filename: string, driveOwner: Pick<AuthUser, "id" | "role">): Promise<string> {
    const accessToken = await this.integrations.googleDriveAccessToken(driveOwner);
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
