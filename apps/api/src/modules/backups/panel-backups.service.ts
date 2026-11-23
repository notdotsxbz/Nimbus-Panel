import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { PanelBackupSchedule, type PanelBackupScheduleDocument } from "./panel-backup-schedule.schema";

const execFileAsync = promisify(execFile);

@Injectable()
export class PanelBackupsService implements OnModuleInit, OnModuleDestroy {
  private workerTimer?: ReturnType<typeof setInterval>;
  private workerBusy = false;
  private scheduleBusy = false;
  constructor(
    @InjectModel(PanelBackup.name) private readonly panelBackups: Model<PanelBackupDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(PanelBackupSchedule.name) private readonly panelSchedules: Model<PanelBackupScheduleDocument>,
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
    this.workerTimer = setInterval(() => { void this.processNextQueuedBackup(); void this.processDuePanelSchedule(); }, 5000);
    void this.processNextQueuedBackup();
    void this.processDuePanelSchedule();
  }

  onModuleDestroy() {
    if (this.workerTimer) clearInterval(this.workerTimer);
  }

  async createFullPanelBackup(user: AuthUser, trigger: "manual" | "scheduled" = "manual") {
    this.assertAdmin(user);
    const activeJob = await this.panelBackups.exists({
      createdBy: new Types.ObjectId(user.id),
      mode: "full",
      status: { $in: ["queued", "running"] },
    });
    if (activeJob) throw new BadRequestException("A full panel backup is already queued or running for this Admin account");
    this.backups.assertBackupEncryptionConfigured();
    await this.integrations.googleDriveAccessToken(user);
    const [services, nodes, customerCount] = await Promise.all([
      this.services.listAllForStaff(user),
      this.nodes.list(),
      this.users.countDocuments({ role: "customer" }),
    ]);
    const record = await this.panelBackups.create({
      createdBy: new Types.ObjectId(user.id),
      mode: "full",
      trigger,
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
    }).catch(() => undefined);
    return record;
  }

  private nextPanelScheduleRun(frequency: "daily" | "weekly", backupTime: string, from: Date): Date {
    const [hours, minutes] = backupTime.split(":").map(Number);
    const next = new Date(from);
    next.setUTCHours(hours, minutes, 0, 0);
    if (next <= from) next.setUTCDate(next.getUTCDate() + (frequency === "weekly" ? 7 : 1));
    return next;
  }

  async getFullBackupSchedule(user: AuthUser) {
    this.assertAdmin(user);
    return this.panelSchedules.findOne({ ownerId: new Types.ObjectId(user.id) });
  }

  async upsertFullBackupSchedule(user: AuthUser, dto: { enabled?: boolean; frequency: "daily" | "weekly"; backupTime?: string }) {
    this.assertAdmin(user);
    if (!["daily", "weekly"].includes(dto.frequency)) throw new BadRequestException("Frequency must be daily or weekly");
    const backupTime = dto.backupTime ?? "03:00";
    if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(backupTime)) throw new BadRequestException("Backup time must use HH:mm in UTC");
    if (dto.enabled !== false) {
      this.backups.assertBackupEncryptionConfigured();
      await this.integrations.googleDriveAccessToken(user);
    }
    const schedule = await this.panelSchedules.findOneAndUpdate(
      { ownerId: new Types.ObjectId(user.id) },
      {
        $set: {
          enabled: dto.enabled ?? true,
          frequency: dto.frequency,
          backupTime,
          timezone: "UTC",
          nextRunAt: this.nextPanelScheduleRun(dto.frequency, backupTime, new Date()),
          lastError: undefined,
        },
        $setOnInsert: { ownerId: new Types.ObjectId(user.id) },
      },
      { upsert: true, new: true, runValidators: true },
    );
    await this.audit.log({ actorId: user.id, action: "backups.panel.schedule.upsert", targetType: "panel-backup-schedule", targetId: schedule._id!.toString(), sensitive: true }).catch(() => undefined);
    return schedule;
  }

  async removeFullBackupSchedule(user: AuthUser) {
    this.assertAdmin(user);
    const result = await this.panelSchedules.deleteOne({ ownerId: new Types.ObjectId(user.id) });
    await this.audit.log({ actorId: user.id, action: "backups.panel.schedule.delete", targetType: "panel-backup-schedule", sensitive: true }).catch(() => undefined);
    return { deleted: Boolean(result.deletedCount) };
  }

  private async processDuePanelSchedule() {
    if (this.scheduleBusy) return;
    this.scheduleBusy = true;
    try {
      const now = new Date();
      const candidate = await this.panelSchedules.findOne({ enabled: true, nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 });
      if (!candidate) return;
      const activeJob = await this.panelBackups.exists({
        createdBy: candidate.ownerId,
        mode: "full",
        status: { $in: ["queued", "running"] },
      });
      if (activeJob) return;
      const nextRunAt = this.nextPanelScheduleRun(candidate.frequency, candidate.backupTime, now);
      const claimed = await this.panelSchedules.findOneAndUpdate(
        { _id: candidate._id, enabled: true, nextRunAt: candidate.nextRunAt },
        { $set: { nextRunAt, lastRunAt: now, lastStatus: "queued", lastError: undefined } },
        { new: true },
      );
      if (!claimed) return;
      const account = await this.users.findById(claimed.ownerId).select("role suspended deletedAt");
      if (!account || account.suspended || account.deletedAt || (account.role !== "owner" && account.role !== "admin")) {
        claimed.enabled = false;
        claimed.lastStatus = "failed";
        claimed.lastError = "Admin account is unavailable; scheduled full backups disabled.";
        await claimed.save();
        return;
      }
      const actor = { id: claimed.ownerId.toString(), role: account.role } as AuthUser;
      try {
        await this.createFullPanelBackup(actor, "scheduled");
        claimed.lastStatus = "queued";
        claimed.lastError = undefined;
      } catch (error) {
        claimed.lastStatus = "failed";
        claimed.lastError = error instanceof Error ? error.message : "Could not queue scheduled full backup";
      }
      await claimed.save();
    } catch {
      // Keep the schedule worker alive if one schedule cannot be processed.
    } finally {
      this.scheduleBusy = false;
    }
  }

  async createSelectedBackup(user: AuthUser, dto: { customerIds?: string[]; serviceIds?: string[] }) {
    this.assertAdmin(user);
    this.backups.assertBackupEncryptionConfigured();
    await this.integrations.googleDriveAccessToken(user);
    const customerIds = [...new Set(dto.customerIds ?? [])];
    const serviceIds = [...new Set(dto.serviceIds ?? [])];
    if (customerIds.length > 50 || serviceIds.length > 100) throw new BadRequestException("Select no more than 50 customers or 100 services at a time");
    if ((customerIds.length === 0) === (serviceIds.length === 0)) {
      throw new BadRequestException("Select either customers or services for this backup job");
    }
    const validId = (id: string) => /^[a-f0-9]{24}$/i.test(id);
    if (![...customerIds, ...serviceIds].every(validId)) throw new BadRequestException("One or more selected IDs are invalid");
    const allServices = await this.services.listAllForStaff(user);
    if (customerIds.length) {
      const foundCustomers = await this.users.find({ _id: { $in: customerIds.map(id => new Types.ObjectId(id)) }, role: "customer" }).select("_id").lean();
      if (foundCustomers.length !== customerIds.length) throw new NotFoundException("One or more selected customers were not found");
    }
    const selected = customerIds.length
      ? allServices.filter(service => customerIds.includes(service.ownerId.toString()))
      : allServices.filter(service => serviceIds.includes(service._id!.toString()));
    if (selected.length === 0) throw new NotFoundException("No eligible services were found for the selection");
    if (serviceIds.length && selected.length !== serviceIds.length) throw new NotFoundException("One or more selected services were not found");
    const record = await this.panelBackups.create({
      createdBy: new Types.ObjectId(user.id),
      mode: customerIds.length ? "customers" : "services",
      selectedCustomerIds: customerIds.map(id => new Types.ObjectId(id)),
      selectedServiceIds: serviceIds.map(id => new Types.ObjectId(id)),
      status: "queued",
      progress: 0,
      currentStep: "Queued",
      customerCount: customerIds.length || new Set(selected.map(service => service.ownerId.toString())).size,
      serviceCount: selected.length,
      nodeCount: new Set(selected.map(service => service.nodeId.toString())).size,
      serviceBackupIds: [],
    });
    await this.audit.log({
      actorId: user.id,
      action: customerIds.length ? "backups.panel.customers.started" : "backups.panel.services.started",
      targetType: "panel-backup",
      targetId: record._id!.toString(),
      detail: `queued; customers=${record.customerCount}; services=${record.serviceCount}`,
      sensitive: true,
    }).catch(() => undefined);
    return record;
  }

  private async processNextQueuedBackup() {
    if (this.workerBusy) return;
    this.workerBusy = true;
    let claimed: PanelBackupDocument | null = null;
    try {
      claimed = await this.panelBackups.findOneAndUpdate(
        { status: "queued" },
        { $set: { status: "running", startedAt: new Date(), currentStep: "Starting", progress: 1 } },
        { sort: { createdAt: 1 }, new: true },
      );
      if (!claimed) return;
      const creator = await this.users.findById(claimed.createdBy).select("role suspended deletedAt");
      if (!creator || creator.suspended || creator.deletedAt || (creator.role !== "owner" && creator.role !== "admin")) {
        claimed.status = "failed";
        claimed.currentStep = "Failed";
        claimed.error = "The Admin who requested this backup is no longer authorized.";
        await claimed.save();
        return;
      }
      const actor = { id: claimed.createdBy.toString(), role: creator.role } as AuthUser;
      if (claimed.mode === "full") await this.performFullPanelBackup(claimed, actor);
      else await this.performSelectedBackups(claimed, actor);
    } catch (error) {
      if (claimed) {
        claimed.status = "failed";
        claimed.currentStep = "Failed";
        claimed.error = error instanceof Error ? error.message : "Background backup worker failed";
        await claimed.save().catch(() => undefined);
      }
    } finally {
      this.workerBusy = false;
    }
  }

  private async performFullPanelBackup(record: PanelBackupDocument, user: AuthUser) {
    const installDir = process.env.NIMBUS_INSTALL_DIR || "/opt/nimbus";
    const pendingRoot = join(installDir, "var", "pending-backups");
    await mkdir(pendingRoot, { recursive: true, mode: 0o700 });
    await chmod(pendingRoot, 0o700);
    const tempDir = await mkdtemp(join(pendingRoot, `${record._id!.toString()}-`));
    let preserveSourceArtifacts = false;
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

      // Service snapshots are completed first so their backup records and Drive
      // file IDs are present in the subsequent MongoDB dump.
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
          nodeId: service.nodeId.toString(),
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
        const progress = 5 + Math.round(((index + 1) / Math.max(eligibleServices.length, 1)) * 45);
        await updateProgress(`Backing up service ${index + 1} of ${eligibleServices.length}: ${service.name}`, progress);
      }

      await updateProgress("Dumping panel database and backup records", 55);
      // Keep the MongoDB URI out of process arguments; mongodump reads a
      // mode-0600 config file instead.
      await writeFile(mongoConfigPath, `uri: ${JSON.stringify(env.mongoUri)}\n`, { mode: 0o600 });
      await execFileAsync("mongodump", ["--config", mongoConfigPath, "--archive", databasePath, "--gzip"], {
        timeout: 60 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });

      await updateProgress("Encrypting and uploading panel database", 65);
      const databaseArtifact = await this.backups.uploadAdminPanelArtifact(
        databasePath,
        `nimbus-database-${record._id!.toString()}.archive.gz`,
        ["Panel", "Database"],
        user,
      );
      await updateProgress("Encrypting and uploading panel configuration", 75);
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
      await updateProgress("Uploading infrastructure metadata", 85);
      const metadataArtifact = await this.backups.uploadAdminPanelArtifact(
        metadataPath,
        `nimbus-system-metadata-${record._id!.toString()}.json`,
        ["Panel", "System Metadata"],
        user,
      );

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
      if (record.trigger === "scheduled") {
        await this.panelSchedules.updateOne(
          { ownerId: record.createdBy },
          { $set: { lastStatus: record.status, lastError: record.status === "failed" ? record.error : undefined } },
        ).catch(() => undefined);
      }

      await this.audit.log({
        actorId: user.id,
        action: "backups.panel.full.completed",
        targetType: "panel-backup",
        targetId: record._id!.toString(),
        detail: `status=${record.status}; customers=${customerCount}; services=${services.length}; nodes=${nodes.length}`,
        sensitive: true,
      }).catch(() => undefined);
    } catch (error) {
      record.status = "failed";
      record.currentStep = "Failed";
      record.error = `${error instanceof Error ? error.message : "Full panel backup failed"}. Source artifacts preserved at ${tempDir}`;
      preserveSourceArtifacts = true;
      await record.save();
      if (record.trigger === "scheduled") {
        await this.panelSchedules.updateOne(
          { ownerId: record.createdBy },
          { $set: { lastStatus: "failed", lastError: record.error } },
        ).catch(() => undefined);
      }
      await this.audit.log({
        actorId: user.id,
        action: "backups.panel.full.failed",
        targetType: "panel-backup",
        targetId: record._id!.toString(),
        sensitive: true,
      }).catch(() => undefined);
    } finally {
      if (!preserveSourceArtifacts) await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async performSelectedBackups(record: PanelBackupDocument, user: AuthUser) {
    const tempDir = await mkdtemp(join(tmpdir(), "nimbus-selected-backup-"));
    try {
      const allServices = await this.services.listAllForStaff(user);
      const customerIds = (record.selectedCustomerIds ?? []).map(id => id.toString());
      const serviceIds = (record.selectedServiceIds ?? []).map(id => id.toString());
      const selected = customerIds.length
        ? allServices.filter(service => customerIds.includes(service.ownerId.toString()))
        : allServices.filter(service => serviceIds.includes(service._id!.toString()));
      const eligible = selected.filter(service => !["vps", "vds"].includes(String(service.type).toLowerCase()));
      const excluded = selected.filter(service => ["vps", "vds"].includes(String(service.type).toLowerCase()));
      const serviceBackups: Array<Record<string, unknown>> = [];
      const backupIds: Types.ObjectId[] = [];
      let failures = excluded.length;
      for (let index = 0; index < eligible.length; index += 1) {
        const service = eligible[index];
        const backup = await this.backups.create(service._id!.toString(), user, "manual", "gdrive");
        backupIds.push(backup._id as Types.ObjectId);
        serviceBackups.push({
          backupId: backup._id!.toString(),
          serviceId: service._id!.toString(),
          ownerId: service.ownerId.toString(),
          nodeId: service.nodeId.toString(),
          serviceName: service.name,
          serviceType: String(service.type),
          status: backup.status,
          sizeBytes: backup.sizeBytes ?? null,
          checksum: backup.checksum ?? null,
          remoteFileId: backup.remoteFileId ?? null,
          encryptionAlgorithm: backup.encryptionAlgorithm ?? null,
          encryptionIv: backup.encryptionIv ?? null,
          encryptionTag: backup.encryptionTag ?? null,
          storedSizeBytes: backup.storedSizeBytes ?? null,
        });
        if (backup.status !== "completed") failures += 1;
        record.currentStep = `Backing up selected service ${index + 1} of ${eligible.length}: ${service.name}`;
        record.progress = 10 + Math.round(((index + 1) / Math.max(eligible.length, 1)) * 75);
        await record.save();
      }
      const manifest = {
        format: "nimbus-selected-backup",
        formatVersion: 1,
        backupId: record._id!.toString(),
        mode: record.mode,
        createdAt: new Date().toISOString(),
        customerIds,
        serviceIds,
        serviceBackups,
        excludedServices: excluded.map(service => ({
          serviceId: service._id!.toString(),
          serviceName: service.name,
          serviceType: String(service.type),
          reason: "Full VM/disk snapshots are not supported by the current Docker-only Node Agent",
        })),
        result: failures ? "partial" : "complete",
      };
      const manifestPath = join(tempDir, "selected-backup-manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      record.currentStep = "Uploading selected backup manifest";
      record.progress = 95;
      await record.save();
      const artifact = await this.backups.uploadAdminPanelArtifact(
        manifestPath,
        `nimbus-selected-manifest-${record._id!.toString()}.json`,
        ["Panel", "Backup Manifest"],
        user,
      );
      record.manifestFileId = artifact.fileId;
      record.serviceBackupIds = backupIds;
      record.manifest = manifest;
      record.totalSizeBytes = serviceBackups.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0);
      record.status = failures ? "partial" : "completed";
      record.currentStep = record.status === "completed" ? "Completed" : "Completed with exclusions or failures";
      record.progress = 100;
      record.completedAt = new Date();
      await record.save();
      await this.audit.log({
        actorId: user.id,
        action: record.mode === "customers" ? "backups.panel.customers.completed" : "backups.panel.services.completed",
        targetType: "panel-backup",
        targetId: record._id!.toString(),
        detail: `status=${record.status}; services=${selected.length}`,
        sensitive: true,
      }).catch(() => undefined);
    } catch (error) {
      record.status = "failed";
      record.currentStep = "Failed";
      record.error = error instanceof Error ? error.message : "Selected backup failed";
      await record.save();
      await this.audit.log({
        actorId: user.id,
        action: "backups.panel.selected.failed",
        targetType: "panel-backup",
        targetId: record._id!.toString(),
        sensitive: true,
      }).catch(() => undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async prepareRestore(id: string, user: AuthUser) {
    this.assertAdmin(user);
    const record = await this.get(id, user);
    if (record.mode !== "full" || !["completed", "partial"].includes(record.status)) {
      throw new BadRequestException("Only a completed full panel backup can be prepared for restore");
    }
    const manifest = record.manifest as {
      artifacts?: {
        database?: { fileId: string; checksum: string; encryptionIv: string; encryptionTag: string; sizeBytes: number; storedSizeBytes: number };
        configuration?: { fileId: string; checksum: string; encryptionIv: string; encryptionTag: string; sizeBytes: number; storedSizeBytes: number };
        systemMetadata?: { fileId: string; checksum: string; encryptionIv: string; encryptionTag: string; sizeBytes: number; storedSizeBytes: number };
      };
    } | undefined;
    const database = manifest?.artifacts?.database;
    const configuration = manifest?.artifacts?.configuration;
    const systemMetadata = manifest?.artifacts?.systemMetadata;
    if (!database || !configuration || !systemMetadata) {
      throw new BadRequestException("Full backup manifest is missing required restore artifacts");
    }

    const installDir = process.env.NIMBUS_INSTALL_DIR || "/opt/nimbus";
    const restoreRoot = join(installDir, "var", "restore-staging");
    const restoreDir = join(restoreRoot, id);
    await mkdir(restoreRoot, { recursive: true, mode: 0o700 });
    await chmod(restoreRoot, 0o700);
    try {
      await mkdir(restoreDir, { recursive: false, mode: 0o700 });
    } catch {
      throw new BadRequestException("A restore package for this backup already exists. Move it aside before preparing another.");
    }

    try {
      await this.backups.downloadAdminPanelArtifact(database.fileId, database, user, join(restoreDir, "database.archive.gz"));
      await this.backups.downloadAdminPanelArtifact(configuration.fileId, configuration, user, join(restoreDir, "environment.env"));
      await this.backups.downloadAdminPanelArtifact(systemMetadata.fileId, systemMetadata, user, join(restoreDir, "system-metadata.json"));
      const checksumHex = (value: string) => /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : Buffer.from(value, "base64").toString("hex");
      await writeFile(join(restoreDir, "database.archive.gz.sha256"), `${checksumHex(database.checksum)}  database.archive.gz\n`, { mode: 0o600, flag: "wx" });
      await writeFile(join(restoreDir, "environment.env.sha256"), `${checksumHex(configuration.checksum)}  environment.env\n`, { mode: 0o600, flag: "wx" });
      await writeFile(join(restoreDir, "system-metadata.json.sha256"), `${checksumHex(systemMetadata.checksum)}  system-metadata.json\n`, { mode: 0o600, flag: "wx" });
      await writeFile(join(restoreDir, "manifest.json"), JSON.stringify(record.manifest, null, 2), { mode: 0o600, flag: "wx" });
      await writeFile(
        join(restoreDir, "README-RESTORE.txt"),
        [
          "NIMBUS full panel restore package",
          "",
          "This package has been downloaded and integrity-verified. It does not modify the live panel.",
          "Review manifest.json and excluded service entries before proceeding.",
          "Run the restore script only during a planned maintenance window and after reviewing its prompts.",
          "After the panel database and configuration are restored, use the Admin Backups page to restore the listed customer service backups.",
          "",
          "Restore script: " + join(installDir, "installer", "restore-panel-backup.sh"),
          "Backup ID: " + id,
        ].join("\n"),
        { mode: 0o600, flag: "wx" },
      );
      await this.audit.log({
        actorId: user.id,
        action: "backups.panel.full.restore-prepared",
        targetType: "panel-backup",
        targetId: id,
        sensitive: true,
      }).catch(() => undefined);
      return {
        prepared: true,
        stagingPath: restoreDir,
        command: `sudo env NIMBUS_INSTALL_DIR="${installDir}" bash ${join(installDir, "installer", "restore-panel-backup.sh")} ${id}`,
        note: "This prepares the panel database and configuration restore. Customer service archives are separate and must be restored from the Admin Backups page after the panel restarts.",
      };
    } catch (error) {
      await rm(restoreDir, { recursive: true, force: true });
      throw error;
    }
  }

  async get(id: string, user: AuthUser) {
    this.assertAdmin(user);
    const record = await this.panelBackups.findById(id);
    if (!record) throw new NotFoundException("Panel backup not found");
    return record;
  }
}
