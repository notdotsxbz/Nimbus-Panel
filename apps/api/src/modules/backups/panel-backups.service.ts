import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import type { AuthUser } from "../../common/auth.decorators";
import { env } from "../../config/env";
import { AuditService } from "../audit/audit.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { NodesService } from "../nodes/nodes.service";
import { ServicesService } from "../services/services.service";
import { User, type UserDocument } from "../users/user.schema";
import { BackupsService } from "./backups.service";
import { PanelBackup, type PanelBackupDocument } from "./panel-backup.schema";

const execFileAsync = promisify(execFile);

@Injectable()
export class PanelBackupsService implements OnModuleInit, OnModuleDestroy {
  private workerTimer?: ReturnType<typeof setInterval>;
  private workerBusy = false;
  constructor(
    @InjectModel(PanelBackup.name) private readonly panelBackups: Model<PanelBackupDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly backups: BackupsService,
    private readonly services: ServicesService,
    private readonly nodes: NodesService,
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditService,
  ) {}

  private assertAdmin(user: AuthUser) {
    if (user.role !== "owner" && user.role !== "admin") {
      throw new ForbiddenException("Only authorized Admins can manage full panel backups");
    }
  }

  async list(user: AuthUser) {
    this.assertAdmin(user);
    return this.panelBackups.find().sort({ createdAt: -1 }).limit(50);
  }

  async onModuleInit() {
    // A process restart interrupts an in-flight full backup. Mark it failed
    // rather than silently claiming completion or starting a duplicate run.
    await this.panelBackups.updateMany(
      { status: "running" },
      { $set: { status: "failed", currentStep: "Interrupted", error: "API restarted while this backup was running. Start a new backup." } },
    );
    this.workerTimer = setInterval(() => { void this.processNextQueuedBackup(); }, 5000);
    void this.processNextQueuedBackup();
  }

  onModuleDestroy() {
    if (this.workerTimer) clearInterval(this.workerTimer);
  }

  async createFullPanelBackup(user: AuthUser) {
    this.assertAdmin(user);
    this.backups.assertBackupEncryptionConfigured();
    await this.integrations.googleDriveAccessToken(user);
    const [services, nodes, customerCount] = await Promise.all([
      this.services.listAllForStaff(user),
      this.nodes.list(),
      this.users.countDocuments({ role: "customer" }),
    ]);
    const record = await this.panelBackups.create({
      createdBy: new Types.ObjectId(user.id),
      status: "queued",
      progress: 0,
      currentStep: "Queued",
      customerCount,
      serviceCount: services.length,
      nodeCount: nodes.length,
      serviceBackupIds: [],
    });
    await this.audit.log({
      actorId: user.id,
      action: "backups.panel.full.started",
      targetType: "panel-backup",
      targetId: record._id!.toString(),
      detail: `queued; customers=${customerCount}; services=${services.length}; nodes=${nodes.length}`,
      sensitive: true,
    });
    return record;
  }

  private async processNextQueuedBackup() {
    if (this.workerBusy) return;
    this.workerBusy = true;
    try {
      const record = await this.panelBackups.findOneAndUpdate(
        { status: "queued" },
        { $set: { status: "running", startedAt: new Date(), currentStep: "Starting", progress: 1 } },
        { sort: { createdAt: 1 }, new: true },
      );
      if (!record) return;
      const creator = await this.users.findById(record.createdBy).select("role suspended deletedAt");
      if (!creator || creator.suspended || creator.deletedAt || (creator.role !== "owner" && creator.role !== "admin")) {
        record.status = "failed";
        record.currentStep = "Failed";
        record.error = "The Admin who requested this backup is no longer authorized.";
        await record.save();
        return;
      }
      const actor = { id: record.createdBy.toString(), role: creator.role } as AuthUser;
      await this.performFullPanelBackup(record, actor);
    } catch {
      // A claimed record is marked failed by performFullPanelBackup; this
      // guard keeps the worker alive if claiming or loading a record fails.
    } finally {
      this.workerBusy = false;
    }
  }

  private async performFullPanelBackup(record: PanelBackupDocument, user: AuthUser) {
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-panel-full-backup-"));
    const updateProgress = async (step: string, progress: number) => {
      record.currentStep = step;
      record.progress = progress;
      await record.save();
    };
    try {
      this.backups.assertBackupEncryptionConfigured();
      await this.integrations.googleDriveAccessToken(user);
      const [services, nodes, customerCount] = await Promise.all([
        this.services.listAllForStaff(user),
        this.nodes.list(),
        this.users.countDocuments({ role: "customer" }),
      ]);
      const eligibleServices = services.filter(service => !["vps", "vds"].includes(String(service.type).toLowerCase()));
      const excludedServices = services
        .filter(service => ["vps", "vds"].includes(String(service.type).toLowerCase()))
        .map(service => ({
          serviceId: service._id!.toString(),
          name: service.name,
          type: String(service.type),
          reason: "Full VM/disk snapshots are not supported by the current Docker-only Node Agent",
        }));
      const manifest: Record<string, unknown> = {
        format: "nimbus-full-panel-backup",
        formatVersion: 1,
        backupId: record._id!.toString(),
        createdAt: new Date().toISOString(),
        consistency: "Best-effort sequential snapshot; this is not a globally quiesced point-in-time snapshot",
        counts: { customers: customerCount, services: services.length, eligibleServices: eligibleServices.length, nodes: nodes.length },
        excludedServices,
        serviceBackups: [],
      };

      const mongoConfigPath = join(tempDir, "mongodump.yml");
      const databasePath = join(tempDir, "nimbus-database.archive.gz");
      const configPath = process.env.NIMBUS_ENV_FILE || "/opt/nimbus/.env";
      const metadataPath = join(tempDir, "system-metadata.json");
      const manifestPath = join(tempDir, "backup-manifest.json");

      await updateProgress("Dumping panel database", 5);
      // Keep the MongoDB URI out of process arguments; mongodump reads a
      // mode-0600 config file instead.
      await writeFile(mongoConfigPath, `uri: ${JSON.stringify(env.mongoUri)}\n`, { mode: 0o600 });
      await execFileAsync("mongodump", ["--config", mongoConfigPath, "--archive", databasePath, "--gzip"], {
        timeout: 60 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });

      await updateProgress("Encrypting and uploading panel database", 15);
      const databaseArtifact = await this.backups.uploadAdminPanelArtifact(
        databasePath,
        `nimbus-database-${record._id!.toString()}.archive.gz`,
        ["Panel", "Database"],
        user,
      );
      await updateProgress("Encrypting and uploading panel configuration", 25);
      const configurationArtifact = await this.backups.uploadAdminPanelArtifact(
        configPath,
        `nimbus-environment-${record._id!.toString()}.env`,
        ["Panel", "Configuration"],
        user,
      );

      const systemMetadata = {
        format: "nimbus-system-metadata",
        backupId: record._id!.toString(),
        createdAt: new Date().toISOString(),
        panelDomain: env.panelDomain,
        webUrl: env.webUrl,
        nodes: nodes.map(node => ({
          id: node._id!.toString(),
          name: node.name,
          ip: node.ip,
          agentUrl: node.agentUrl,
          os: node.os,
          location: node.location,
          cpuCores: node.cpuCores,
          ramTotalMb: node.ramTotalMb,
          diskTotalGb: node.diskTotalGb,
          status: node.status,
          maintenanceMode: node.maintenanceMode,
        })),
        services: services.map(service => ({
          id: service._id!.toString(),
          ownerId: service.ownerId.toString(),
          name: service.name,
          type: String(service.type),
          nodeId: service.nodeId.toString(),
          status: service.status,
          ramMb: service.ramMb,
          diskGb: service.diskGb,
        })),
      };
      await writeFile(metadataPath, JSON.stringify(systemMetadata, null, 2), { mode: 0o600 });
      await updateProgress("Uploading infrastructure metadata", 30);
      const metadataArtifact = await this.backups.uploadAdminPanelArtifact(
        metadataPath,
        `nimbus-system-metadata-${record._id!.toString()}.json`,
        ["Panel", "System Metadata"],
        user,
      );

      const serviceBackups: Array<Record<string, unknown>> = [];
      const backupIds: Types.ObjectId[] = [];
      let serviceFailures = 0;
      for (let index = 0; index < eligibleServices.length; index += 1) {
        const service = eligibleServices[index];
        const serviceBackup = await this.backups.create(service._id!.toString(), user, "manual", "gdrive");
        backupIds.push(serviceBackup._id as Types.ObjectId);
        serviceBackups.push({
          backupId: serviceBackup._id!.toString(),
          serviceId: service._id!.toString(),
          ownerId: service.ownerId.toString(),
          serviceName: service.name,
          serviceType: String(service.type),
          status: serviceBackup.status,
          sizeBytes: serviceBackup.sizeBytes ?? null,
          checksum: serviceBackup.checksum ?? null,
          remoteFileId: serviceBackup.remoteFileId ?? null,
          encryptionAlgorithm: serviceBackup.encryptionAlgorithm ?? null,
          encryptionIv: serviceBackup.encryptionIv ?? null,
          encryptionTag: serviceBackup.encryptionTag ?? null,
          storedSizeBytes: serviceBackup.storedSizeBytes ?? null,
        });
        if (serviceBackup.status !== "completed") serviceFailures += 1;
        const progress = 35 + Math.round(((index + 1) / Math.max(eligibleServices.length, 1)) * 55);
        await updateProgress(`Backing up service ${index + 1} of ${eligibleServices.length}: ${service.name}`, progress);
      }

      const completeManifest = {
        ...manifest,
        serviceBackups,
        artifacts: {
          database: databaseArtifact,
          configuration: configurationArtifact,
          systemMetadata: metadataArtifact,
        },
        excluded: {
          fullVmSnapshots: excludedServices,
          note: "VPS/VDS full disk images are excluded because the current Node Agent provisions Docker workloads only.",
        },
        result: serviceFailures || excludedServices.length ? "partial" : "complete",
      };
      await writeFile(manifestPath, JSON.stringify(completeManifest, null, 2), { mode: 0o600 });
      await updateProgress("Uploading full backup manifest", 95);
      const manifestArtifact = await this.backups.uploadAdminPanelArtifact(
        manifestPath,
        `nimbus-full-manifest-${record._id!.toString()}.json`,
        ["Panel", "Backup Manifest"],
        user,
      );

      record.databaseFileId = databaseArtifact.fileId;
      record.configurationFileId = configurationArtifact.fileId;
      record.systemMetadataFileId = metadataArtifact.fileId;
      record.manifestFileId = manifestArtifact.fileId;
      record.serviceBackupIds = backupIds;
      record.manifest = completeManifest;
      record.totalSizeBytes =
        databaseArtifact.sizeBytes +
        configurationArtifact.sizeBytes +
        metadataArtifact.sizeBytes +
        serviceBackups.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0);
      record.status = serviceFailures || excludedServices.length ? "partial" : "completed";
      record.currentStep = record.status === "completed" ? "Completed" : "Completed with exclusions or failures";
      record.progress = 100;
      record.completedAt = new Date();
      await record.save();

      await this.audit.log({
        actorId: user.id,
        action: "backups.panel.full.completed",
        targetType: "panel-backup",
        targetId: record._id!.toString(),
        detail: `status=${record.status}; customers=${customerCount}; services=${services.length}; nodes=${nodes.length}`,
        sensitive: true,
      });
    } catch (error) {
      record.status = "failed";
      record.currentStep = "Failed";
      record.error = error instanceof Error ? error.message : "Full panel backup failed";
      await record.save();
      await this.audit.log({
        actorId: user.id,
        action: "backups.panel.full.failed",
        targetType: "panel-backup",
        targetId: record._id!.toString(),
        sensitive: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async get(id: string, user: AuthUser) {
    this.assertAdmin(user);
    const record = await this.panelBackups.findById(id);
    if (!record) throw new NotFoundException("Panel backup not found");
    return record;
  }
}
