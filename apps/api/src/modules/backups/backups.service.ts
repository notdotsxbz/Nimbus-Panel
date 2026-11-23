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
        const customer = await this.users.findById(service.ownerId).select("displayName username").lean();
        const customerName = customer?.displayName || customer?.username || "customer";
        backup.remoteFileId = await this.uploadGoogleDriveArchive(
          archive,
          `nimbus-${serviceId}-${backup._id!.toString()}.tar`,
          driveOwner,
          { serviceId, serviceName: service.name, serviceType: String(service.type), customerName, customerId: service.ownerId.toString() },
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
    if (!backup.checksum) throw new BadRequestException("Backup has no integrity checksum and cannot be restored safely");
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
    archive: Buffer,
    filename: string,
    driveOwner: Pick<AuthUser, "id" | "role">,
    service: { serviceId: string; serviceName: string; serviceType: string; customerName: string; customerId: string },
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
    let metadata;
    try {
      metadata = await axios.post(
        "https://www.googleapis.com/drive/v3/files?fields=id,name",
        { name: filename, mimeType: "application/octet-stream", parents: [serviceFolderId] },
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
