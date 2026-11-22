import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import axios from "axios";
import { Model, Types } from "mongoose";
import { AuditService } from "../audit/audit.service";
import { ServicesService } from "../services/services.service";
import { Service, ServiceDocument } from "../services/service.schema";
import { NodesService } from "../nodes/nodes.service";
import { BackupsService } from "../backups/backups.service";
import { AuthUser } from "../../common/auth.decorators";
import { Software, SoftwareDocument } from "./software.schema";
import { SoftwareVersion, SoftwareVersionDocument } from "./software-version.schema";
import { SoftwareOperation, SoftwareOperationDocument } from "./software-operation.schema";
import { SoftwareSyncJob, SoftwareSyncJobDocument } from "./software-sync-job.schema";

type DiscoveredVersion = {
  version: string;
  releaseName?: string;
  releaseDate?: string;
  prerelease?: boolean;
  sourceUrl?: string;
  sourceId?: string;
  compatibility?: string[];
  metadata?: Record<string, unknown>;
};

@Injectable()
export class SoftwareService implements OnModuleInit, OnModuleDestroy {
  private syncTimer?: NodeJS.Timeout;
  constructor(
    @InjectModel(Software.name) private readonly catalog: Model<SoftwareDocument>,
    @InjectModel(Service.name) private readonly serviceRecords: Model<ServiceDocument>,
    @InjectModel(SoftwareVersion.name) private readonly versions: Model<SoftwareVersionDocument>,
    @InjectModel(SoftwareOperation.name) private readonly operations: Model<SoftwareOperationDocument>,
    @InjectModel(SoftwareSyncJob.name) private readonly syncJobs: Model<SoftwareSyncJobDocument>,
    private readonly services: ServicesService,
    private readonly nodes: NodesService,
    private readonly backups: BackupsService,
    private readonly audit: AuditService,
  ) {}

  private syncWorkerRunning = false;

  onModuleInit() {
    // MongoDB-backed jobs survive API restarts. The timer only wakes the
    // scheduler/worker; job state, retries and leases are persisted.
    this.syncTimer = setInterval(() => { void this.runSyncQueue(); }, 15_000);
    this.syncTimer.unref?.();
    void this.runSyncQueue();
  }
  onModuleDestroy() { if (this.syncTimer) clearInterval(this.syncTimer); }

  private async runSyncQueue() {
    if (this.syncWorkerRunning) return;
    this.syncWorkerRunning = true;
    try {
      await this.enqueueDueSyncs();
      await this.processOneSyncJob();
    } catch (error) {
      console.error("[software-sync-queue] worker tick failed:", error instanceof Error ? error.message : "unknown error");
    } finally {
      this.syncWorkerRunning = false;
    }
  }

  private async enqueueDueSyncs() {
    const now = new Date();
    const rows = await this.catalog.find({ autoSync: true, enabled: true, syncFrequency: { $in: ["6h", "12h", "24h", "7d"] } })
      .select("_id syncFrequency nextSyncAt lastSyncAttemptAt").lean();
    const intervals: Record<string, number> = { "6h": 21_600_000, "12h": 43_200_000, "24h": 86_400_000, "7d": 604_800_000 };
    for (const row of rows) {
      const interval = intervals[row.syncFrequency] ?? 0;
      if (!interval) continue;
      const dueAt = row.nextSyncAt
        ? new Date(row.nextSyncAt)
        : row.lastSyncAttemptAt
          ? new Date(new Date(row.lastSyncAttemptAt).getTime() + interval)
          : now;
      if (dueAt > now) continue;
      const bucket = Math.floor(now.getTime() / interval);
      const jobKey = `software-sync:${row._id.toString()}:${bucket}`;
      await this.syncJobs.updateOne(
        { jobKey },
        { $setOnInsert: { softwareId: row._id, jobKey, status: "queued", attempts: 0, maxAttempts: 5, runAt: now, leaseUntil: null } },
        { upsert: true },
      );
    }
  }

  private async processOneSyncJob() {
    const now = new Date();
    await this.syncJobs.updateMany(
      { status: "running", leaseUntil: { $lte: now }, $expr: { $gte: ["$attempts", "$maxAttempts"] } },
      { $set: { status: "failed", leaseUntil: null, completedAt: now, lastError: "Worker lease expired after the final attempt" } },
    );
    const job = await this.syncJobs.findOneAndUpdate(
      {
        $expr: { $lt: ["$attempts", "$maxAttempts"] },
        $or: [
          { status: { $in: ["queued", "retry"] }, runAt: { $lte: now } },
          { status: "running", leaseUntil: { $lte: now } },
        ],
      },
      { $set: { status: "running", leaseUntil: new Date(now.getTime() + 10 * 60_000), startedAt: now }, $inc: { attempts: 1 } },
      { new: true, sort: { runAt: 1, createdAt: 1 } },
    );
    if (!job) return;
    try {
      const result = await this.discover(job.softwareId.toString(), { id: "system", role: "owner" } as AuthUser);
      await this.syncJobs.updateOne({ _id: job._id }, { $set: {
        status: "completed", leaseUntil: null, completedAt: new Date(), lastError: "",
        discovered: result.discovered, imported: result.imported, skipped: result.skipped, failed: result.failed,
      } });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Version synchronization failed";
      const retryDelays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 0];
      const delay = retryDelays[Math.min(job.attempts - 1, retryDelays.length - 1)];
      const terminal = job.attempts >= 5 || delay === 0;
      await this.syncJobs.updateOne({ _id: job._id }, { $set: {
        status: terminal ? "failed" : "retry", leaseUntil: null,
        runAt: new Date(Date.now() + delay), lastError: message,
        ...(terminal ? { completedAt: new Date() } : {}),
      } });
    }
  }

  async listSyncJobs() {
    return this.syncJobs.find().sort({ createdAt: -1 }).limit(100).populate("softwareId", "name identifier").lean();
  }

  async retrySyncJob(jobId: string, actor: AuthUser) {
    if (!Types.ObjectId.isValid(jobId)) throw new BadRequestException("Invalid sync job ID");
    const job = await this.syncJobs.findById(jobId);
    if (!job) throw new NotFoundException("Sync job not found");
    if (job.status === "running" || job.status === "completed") throw new BadRequestException("Only failed or waiting jobs can be retried");
    job.status = "queued";
    job.attempts = 0;
    job.runAt = new Date();
    job.leaseUntil = null;
    job.lastError = "";
    job.completedAt = undefined;
    await job.save();
    await this.audit.log({ actorId: actor.id, action: "software.sync.retry_requested", targetType: "software", targetId: job.softwareId.toString(), detail: job._id.toString(), sensitive: true });
    return job;
  }
  async list(): Promise<unknown[]> {
    const [rows, counts] = await Promise.all([
      this.catalog.find().sort({ name: 1 }).populate("recommendedVersionId", "version").lean(),
      this.versions.aggregate([{ $group: { _id: "$softwareId", count: { $sum: 1 } } }]),
    ]);
    const versionCounts = new Map<string, number>(counts.map((row: { _id: Types.ObjectId; count: number }): [string, number] => [row._id.toString(), row.count]));
    return rows.map(row => ({ ...row, versionCount: versionCounts.get(row._id.toString()) ?? 0 }));
  }

  listOperations() {
    return this.operations.find().sort({ createdAt: -1 }).limit(100).populate("serviceId", "name type").populate("softwareId", "name identifier").lean();
  }

  private async runDueSyncs() {
    const rows = await this.catalog.find({ autoSync: true, syncFrequency: { $in: ["6h", "12h", "24h", "7d"] } }).select("_id syncFrequency lastSyncAttemptAt").lean();
    const intervals: Record<string, number> = { "6h": 21600000, "12h": 43200000, "24h": 86400000, "7d": 604800000 };
    for (const row of rows) {
      const interval = intervals[row.syncFrequency] ?? 0;
      if (!interval || (row.lastSyncAttemptAt && Date.now() - new Date(row.lastSyncAttemptAt).getTime() < interval)) continue;
      const lease = await this.catalog.findOneAndUpdate({ _id: row._id, $or: [{ syncLeaseUntil: null }, { syncLeaseUntil: { $lt: new Date() } }] }, { $set: { syncLeaseUntil: new Date(Date.now() + 300000) } }, { new: true });
      if (!lease) continue;
      try { await this.discover(row._id.toString(), { id: "system", role: "owner" } as AuthUser); }
      catch { /* sync history records failure; retry next interval */ }
      finally { await this.catalog.updateOne({ _id: row._id }, { $set: { syncLeaseUntil: null } }); }
    }
  }

  async create(input: Partial<Software>, actor: AuthUser) {
    if (!input.name?.trim() || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(input.identifier ?? "")) {
      throw new BadRequestException("Name and a valid lowercase identifier are required");
    }
    if (!Array.isArray(input.serviceTypes) || !input.serviceTypes.length) throw new BadRequestException("Choose at least one supported service type");
    this.validateSource(input.sourceType ?? "manual", input.sourceConfig ?? {});
    this.validateInstallation(input.installationConfig ?? {});
    this.validateCatalogMetadata(input);
    const createFrequency = input.syncFrequency ?? "manual";
    if (!["manual", "6h", "12h", "24h", "7d"].includes(createFrequency)) throw new BadRequestException("Invalid sync frequency");
    if (input.autoSync && createFrequency === "manual") throw new BadRequestException("Choose a sync frequency when automatic sync is enabled");
    const software = await this.catalog.create({
      name: input.name.trim(), identifier: input.identifier, description: input.description ?? "",
      category: input.category ?? "runtime", logoUrl: input.logoUrl ?? "", officialUrl: input.officialUrl ?? "",
      supportedOperatingSystems: input.supportedOperatingSystems ?? [], supportedArchitectures: input.supportedArchitectures ?? [],
      requiredRuntime: input.requiredRuntime ?? "", defaultVersion: input.defaultVersion ?? "",
      serviceTypes: [...new Set(input.serviceTypes)],
      sourceType: input.sourceType ?? "manual", sourceConfig: input.sourceConfig ?? {}, installationConfig: input.installationConfig ?? {},
      enabled: input.enabled ?? true, customerAvailable: input.customerAvailable ?? true,
      autoSync: input.autoSync ?? false, syncFrequency: input.syncFrequency ?? "manual",
      autoPublish: input.autoPublish ?? false,
    });
    await this.audit.log({ actorId: actor.id, action: "software.created", targetType: "software", targetId: software._id.toString(), sensitive: true });
    return software;
  }

  async update(id: string, input: Partial<Software>, actor: AuthUser) {
    const software = await this.catalog.findById(id);
    if (!software) throw new NotFoundException("Software not found");
    if (input.sourceType || input.sourceConfig) this.validateSource(input.sourceType ?? software.sourceType, input.sourceConfig ?? software.sourceConfig);
    if (input.installationConfig) this.validateInstallation(input.installationConfig);
    this.validateCatalogMetadata(input);
    const nextFrequency = input.syncFrequency ?? software.syncFrequency;
    const nextAutoSync = input.autoSync ?? software.autoSync;
    if (!["manual", "6h", "12h", "24h", "7d"].includes(nextFrequency)) throw new BadRequestException("Invalid sync frequency");
    if (nextAutoSync && nextFrequency === "manual") throw new BadRequestException("Choose a sync frequency when automatic sync is enabled");
    if (input.serviceTypes !== undefined && (!Array.isArray(input.serviceTypes) || !input.serviceTypes.length || input.serviceTypes.some(value => typeof value !== "string" || !/^[a-z0-9_-]{2,32}$/.test(value)))) throw new BadRequestException("Choose valid service types");
    const allowed = ["name", "description", "category", "logoUrl", "officialUrl", "supportedOperatingSystems", "supportedArchitectures", "requiredRuntime", "defaultVersion", "serviceTypes", "sourceType", "sourceConfig", "installationConfig", "enabled", "customerAvailable", "autoSync", "syncFrequency", "autoPublish"] as const;
    for (const key of allowed) if (input[key] !== undefined) (software as any)[key] = input[key];
    await software.save();
    await this.audit.log({ actorId: actor.id, action: "software.updated", targetType: "software", targetId: id, sensitive: true });
    return software;
  }

  async removeSoftware(id: string, actor: AuthUser) {
    const software = await this.getSoftware(id);
    const inUse = await this.serviceRecords.countDocuments({ software: software.identifier });
    if (inUse > 0) throw new BadRequestException("This software is assigned to " + inUse + " service(s). Disable it instead of deleting it.");
    await this.versions.deleteMany({ softwareId: software._id });
    await software.deleteOne();
    await this.audit.log({ actorId: actor.id, action: "software.deleted", targetType: "software", targetId: id, sensitive: true });
    return { deleted: true };
  }

  async removeVersion(id: string, versionId: string, actor: AuthUser) {
    const software = await this.getSoftware(id);
    const version = await this.versions.findById(versionId);
    if (!version || version.softwareId.toString() !== software._id.toString()) throw new NotFoundException("Version not found");
    const inUse = await this.serviceRecords.countDocuments({ software: software.identifier, softwareVersion: version.version });
    if (inUse > 0) throw new BadRequestException("This version is currently used by " + inUse + " service(s) and cannot be deleted.");
    await version.deleteOne();
    if (software.recommendedVersionId?.toString() === version._id.toString()) { software.recommendedVersionId = null as never; await software.save(); }
    await this.audit.log({ actorId: actor.id, action: "software.version.deleted", targetType: "software-version", targetId: versionId, sensitive: true });
    return { deleted: true };
  }
  async listVersions(id: string) {
    await this.getSoftware(id);
    return this.versions.find({ softwareId: id }).sort({ releaseDate: -1, version: -1 }).lean();
  }

  async addVersion(id: string, input: Partial<SoftwareVersion>, actor: AuthUser) {
    const software = await this.getSoftware(id);
    if (!input.version?.trim() || input.version.length > 100) throw new BadRequestException("A version identifier is required");
    if (input.releaseName !== undefined && (typeof input.releaseName !== "string" || input.releaseName.length > 200)) throw new BadRequestException("Release name must be 200 characters or fewer");
    if (input.channel !== undefined && !["stable", "beta", "alpha", "prerelease"].includes(input.channel)) throw new BadRequestException("Invalid release channel");
    if (input.releaseDate !== undefined && Number.isNaN(new Date(String(input.releaseDate)).getTime())) throw new BadRequestException("Invalid release date");
    if (input.sourceUrl) {
      let source: URL;
      try { source = new URL(input.sourceUrl); } catch { throw new BadRequestException("Invalid release source URL"); }
      if (source.protocol !== "https:" || source.username || source.password) throw new BadRequestException("Release source must be an HTTPS URL");
    }
    if (input.compatibility !== undefined && (!Array.isArray(input.compatibility) || input.compatibility.length > 50 || input.compatibility.some(value => typeof value !== "string" || value.length > 100))) {
      throw new BadRequestException("Invalid compatibility metadata");
    }
    const existing = await this.versions.findOne({ softwareId: software._id, version: input.version.trim() });
    if (existing) throw new BadRequestException("That version already exists");
    const version = await this.versions.create({
      softwareId: software._id, version: input.version.trim(), releaseName: input.releaseName ?? "",
      releaseDate: input.releaseDate, channel: input.channel ?? "stable", prerelease: input.prerelease ?? false,
      recommended: false, deprecated: false, publicationStatus: "pending", sourceUrl: input.sourceUrl ?? "",
      compatibility: input.compatibility ?? [], metadata: input.metadata ?? {}, importedAt: new Date(),
    });
    await this.audit.log({ actorId: actor.id, action: "software.version.added", targetType: "software-version", targetId: version._id.toString(), sensitive: true });
    return version;
  }

  async previewVersions(id: string, actor: AuthUser) {
    const software = await this.getSoftware(id);
    const discovered = await this.fetchSource(software);
    const identifiers = discovered.map(item => item.version).filter(Boolean);
    const existing = await this.versions.find({ softwareId: software._id, version: { $in: identifiers } }).select("version").lean();
    const existingSet = new Set(existing.map(item => item.version));
    const unique = new Map<string, DiscoveredVersion>();
    for (const item of discovered) if (item.version && item.version.length <= 100 && !unique.has(item.version)) unique.set(item.version, item);
    const preview = [...unique.values()].map(item => ({ ...item, alreadyImported: existingSet.has(item.version) }));
    software.discoveryPreview = preview as unknown as Record<string, unknown>[];
    software.discoveryPreviewAt = new Date();
    await software.save();
    await this.audit.log({ actorId: actor.id, action: "software.versions.previewed", targetType: "software", targetId: id, detail: "discovered=" + preview.length, sensitive: true });
    return { discovered: preview.length, newVersions: preview.filter(item => !item.alreadyImported).length, existingVersions: preview.filter(item => item.alreadyImported).length, versions: preview };
  }

  async importPreviewVersions(id: string, versionNames: string[] | undefined, importAll: boolean, actor: AuthUser) {
    const software = await this.getSoftware(id);
    if (!software.discoveryPreviewAt || Date.now() - software.discoveryPreviewAt.getTime() > 24 * 60 * 60_000) throw new BadRequestException("Version preview expired. Fetch versions again.");
    const preview = software.discoveryPreview as unknown as (DiscoveredVersion & { alreadyImported?: boolean })[];
    const selected = importAll ? preview : preview.filter(item => Array.isArray(versionNames) && versionNames.includes(item.version));
    if (!selected.length || selected.length > 1000) throw new BadRequestException("Select between 1 and 1,000 discovered versions");
    let imported = 0, skipped = 0, failed = 0;
    for (const item of selected) {
      try {
        const result = await this.versions.updateOne({ softwareId: software._id, version: item.version }, { $setOnInsert: {
          softwareId: software._id, version: item.version, releaseName: item.releaseName ?? "", releaseDate: item.releaseDate ? new Date(item.releaseDate) : undefined,
          channel: item.prerelease ? "prerelease" : "stable", prerelease: !!item.prerelease, publicationStatus: software.autoPublish && !item.prerelease ? "published" : "pending",
          sourceUrl: item.sourceUrl ?? "", sourceId: item.sourceId ?? "", compatibility: item.compatibility ?? [], metadata: item.metadata ?? {}, importedAt: new Date(),
        } }, { upsert: true });
        if (result.upsertedCount) imported++; else skipped++;
      } catch { failed++; }
    }
    software.lastSyncedAt = new Date(); software.lastSyncAttemptAt = new Date(); software.lastSyncStatus = failed ? "partial" : "success";
    const syncIntervals: Record<string, number> = { "6h": 21600000, "12h": 43200000, "24h": 86400000, "7d": 604800000 };
    software.nextSyncAt = software.autoSync && syncIntervals[software.syncFrequency] ? new Date(Date.now() + syncIntervals[software.syncFrequency]) : undefined;
    software.syncHistory.push({ startedAt: software.discoveryPreviewAt, completedAt: new Date(), status: software.lastSyncStatus, discovered: selected.length, imported, skipped, failed });
    software.syncHistory = software.syncHistory.slice(-50); software.discoveryPreview = []; software.discoveryPreviewAt = undefined;
    await software.save();
    await this.audit.log({ actorId: actor.id, action: "software.versions.imported", targetType: "software", targetId: id, detail: "imported=" + imported + " skipped=" + skipped + " failed=" + failed, sensitive: true });
    return { discovered: selected.length, imported, skipped, failed };
  }
  async discover(id: string, actor: AuthUser) {
    const software = await this.getSoftware(id);
    const startedAt = new Date();
    software.lastSyncAttemptAt = startedAt;
    await software.save();
    try {
      const discovered = await this.fetchSource(software);
      let imported = 0, skipped = 0, failed = 0;
      for (const item of discovered) {
        try {
          if (!item.version || item.version.length > 100) { failed++; continue; }
          const result = await this.versions.updateOne(
            { softwareId: software._id, version: item.version },
            { $setOnInsert: {
              softwareId: software._id, version: item.version, releaseName: item.releaseName ?? "",
              releaseDate: item.releaseDate ? new Date(item.releaseDate) : undefined,
              channel: item.prerelease ? "prerelease" : "stable", prerelease: !!item.prerelease,
              publicationStatus: software.autoPublish && !item.prerelease ? "published" : "pending",
              sourceUrl: item.sourceUrl ?? "", sourceId: item.sourceId ?? "",
              compatibility: item.compatibility ?? [], metadata: item.metadata ?? {}, importedAt: new Date(),
            } },
            { upsert: true },
          );
          if (result.upsertedCount) imported++; else skipped++;
        } catch { failed++; }
      }
      software.lastSyncedAt = new Date();
      const intervals: Record<string, number> = { "6h": 21600000, "12h": 43200000, "24h": 86400000, "7d": 604800000 };
      software.nextSyncAt = software.autoSync && intervals[software.syncFrequency] ? new Date(Date.now() + intervals[software.syncFrequency]) : undefined;
      software.lastSyncStatus = failed ? "partial" : "success";
      software.syncHistory.push({ startedAt, completedAt: new Date(), status: software.lastSyncStatus, discovered: discovered.length, imported, skipped, failed });
      software.syncHistory = software.syncHistory.slice(-50);
      await software.save();
      await this.audit.log({ actorId: actor.id === "system" ? undefined : actor.id, action: "software.versions.discovered", targetType: "software", targetId: id, detail: `discovered=${discovered.length} imported=${imported} skipped=${skipped} failed=${failed}`, sensitive: true });
      return { discovered: discovered.length, imported, skipped, failed, versions: discovered };
    } catch (error) {
      software.lastSyncStatus = "failed";
      const retryIntervals: Record<string, number> = { "6h": 21600000, "12h": 43200000, "24h": 86400000, "7d": 604800000 };
      software.nextSyncAt = software.autoSync && retryIntervals[software.syncFrequency] ? new Date(Date.now() + retryIntervals[software.syncFrequency]) : undefined;
      software.syncHistory.push({ startedAt, completedAt: new Date(), status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "Source request failed" });
      software.syncHistory = software.syncHistory.slice(-50);
      await software.save();
      throw new BadRequestException("Version discovery failed. Existing catalog entries were retained.");
    }
  }

  async bulkUpdateVersions(id: string, versionIds: string[], action: string, actor: AuthUser) {
    await this.getSoftware(id);
    if (!Array.isArray(versionIds) || versionIds.length < 1 || versionIds.length > 200 || versionIds.some(v => !Types.ObjectId.isValid(v))) throw new BadRequestException("Select between 1 and 200 valid versions");
    const ids = [...new Set(versionIds)].map(v => new Types.ObjectId(v));
    const validCount = await this.versions.countDocuments({ softwareId: id, _id: { $in: ids } });
    if (validCount !== ids.length) throw new BadRequestException("One or more selected versions do not belong to this software entry");
    const update: Record<string, unknown> = {};
    if (action === "publish") update.publicationStatus = "published";
    else if (action === "disable") update.publicationStatus = "disabled";
    else if (action === "pending") update.publicationStatus = "pending";
    else if (action === "deprecate") update.deprecated = true;
    else if (action === "undeprecate") update.deprecated = false;
    else if (action === "recommend" && ids.length === 1) {
      const candidate = await this.versions.findOne({ softwareId: id, _id: ids[0] }).select("publicationStatus deprecated").lean();
      if (!candidate || candidate.publicationStatus !== "published" || candidate.deprecated) {
        throw new BadRequestException("Only published, non-deprecated versions can be recommended");
      }
      await this.versions.updateMany({ softwareId: id }, { $set: { recommended: false } });
      await this.catalog.updateOne({ _id: id }, { $set: { recommendedVersionId: ids[0] } });
      update.recommended = true;
    }
    else throw new BadRequestException("Unsupported bulk action");
    const result = await this.versions.updateMany({ softwareId: id, _id: { $in: ids } }, { $set: update });
    await this.audit.log({ actorId: actor.id, action: "software.versions.bulk_updated", targetType: "software", targetId: id, detail: "action=" + action + " modified=" + result.modifiedCount, sensitive: true });
    return { matched: result.matchedCount, modified: result.modifiedCount };
  }
  async setVersion(id: string, versionId: string, input: { publicationStatus?: string; deprecated?: boolean; recommended?: boolean }, actor: AuthUser) {
    const software = await this.getSoftware(id);
    if (input.publicationStatus && !["pending", "published", "disabled"].includes(input.publicationStatus)) throw new BadRequestException("Invalid publication status");
    const version = await this.versions.findById(versionId);
    if (!version || version.softwareId.toString() !== software._id.toString()) throw new NotFoundException("Version not found");
    if (input.recommended === true) {
      const resultingPublicationStatus = input.publicationStatus ?? version.publicationStatus;
      const resultingDeprecated = input.deprecated ?? version.deprecated;
      if (resultingPublicationStatus !== "published" || resultingDeprecated) {
        throw new BadRequestException("Only published, non-deprecated versions can be recommended");
      }
      await this.versions.updateMany({ softwareId: id }, { $set: { recommended: false } });
      await this.catalog.updateOne({ _id: id }, { $set: { recommendedVersionId: version._id } });
    }
    else if (input.recommended === false) await this.catalog.updateOne({ _id: id, recommendedVersionId: version._id }, { $set: { recommendedVersionId: null } });
    if (input.publicationStatus !== undefined) version.publicationStatus = input.publicationStatus;
    if (input.deprecated !== undefined) version.deprecated = input.deprecated;
    if (input.recommended !== undefined) version.recommended = input.recommended;
    await version.save();
    await this.audit.log({ actorId: actor.id, action: "software.version.updated", targetType: "software-version", targetId: versionId, sensitive: true });
    return version;
  }

  async cleanupPreviousContainer(operationId: string, actor: AuthUser) {
    if (!Types.ObjectId.isValid(operationId)) throw new BadRequestException("Invalid operation ID");
    const operation = await this.operations.findById(operationId);
    if (!operation || operation.status !== "completed") throw new NotFoundException("Completed software operation not found");
    const verification = operation.verification ?? {};
    if (verification.previousContainerRemoved === true) return operation;
    const previousContainerName = String(verification.previousContainerName ?? "");
    const dockerImage = String(verification.installedImage ?? "");
    if (!previousContainerName || !dockerImage) throw new BadRequestException("This operation has no pending container cleanup");
    const service = await this.services.get(operation.serviceId.toString(), actor);
    const node = await this.nodes.get(service.nodeId.toString());
    const result = await this.nodes.agentCall(node, "/services/" + service._id.toString() + "/upgrade-commit", { dockerImage, previousContainerName }, "POST", 60_000) as { status?: string; previousContainerRemoved?: boolean };
    if (result.status !== "committed" || !result.previousContainerRemoved) throw new BadRequestException("Previous container cleanup is still pending; it has been retained for safety");
    operation.verification = { ...verification, previousContainerRemoved: true };
    operation.warning = "";
    await operation.save();
    await this.audit.log({ actorId: actor.id, action: "software.service.upgrade_cleanup_completed", targetType: "service", targetId: operation.serviceId.toString(), detail: operationId, sensitive: true });
    return operation;
  }
  async listServiceOperations(serviceId: string, actor: AuthUser) {
    await this.services.get(serviceId, actor);
    return this.operations.find({ serviceId }).sort({ createdAt: -1 }).limit(50).lean();
  }

  async changeServiceSoftware(serviceId: string, softwareId: string, versionId: string, actor: AuthUser) {
    const service = await this.services.get(serviceId, actor);
    if (["vps", "vds"].includes(service.type.toLowerCase())) throw new BadRequestException("VPS/VDS operating systems can only be changed by an authorized administrator through the OS management workflow");
    if (service.subscriptionStatus !== "active" || service.status === "suspended") throw new BadRequestException("This service is not active");
    if (["installing", "updating", "starting", "stopping", "restarting"].includes(service.status)) throw new BadRequestException("Wait for the current service operation to finish first");
    if (!Types.ObjectId.isValid(softwareId) || !Types.ObjectId.isValid(versionId)) throw new BadRequestException("Invalid software or version");
    const [software, version] = await Promise.all([this.catalog.findById(softwareId), this.versions.findOne({ _id: versionId, softwareId })]);
    if (!software || !version) throw new NotFoundException("Software or version not found");
    if (!software.enabled || !software.customerAvailable || !software.serviceTypes.includes(service.type)) throw new BadRequestException("This software is not available for this service type");
    if (version.publicationStatus !== "published" || version.deprecated) throw new BadRequestException("This version is not available for new installations");
    const template = software.installationConfig?.imageTemplate;
    if (software.installationConfig?.method !== "docker-image-template" || typeof template !== "string" || !template.includes("{version}")) throw new BadRequestException("This catalog entry has no verified installation adapter yet");
    const safeVersion = version.version.replace(/[^A-Za-z0-9_.-]/g, "");
    if (!safeVersion || safeVersion !== version.version) throw new BadRequestException("The selected version cannot be safely used as a container tag");
    const dockerImage = template.replaceAll("{version}", safeVersion);
    if (!/^[A-Za-z0-9._:/@-]+$/.test(dockerImage)) throw new BadRequestException("Configured container image is invalid");
    const beforeStatus = service.status;
    const previousState = { dockerImage: service.dockerImage, software: service.software, softwareVersion: service.softwareVersion, containerId: service.containerId };
    let agentNode: any;
    let agentUpgrade: any;
    let serviceStateSaved = false;
    const operation = await this.operations.create({
      serviceId: service._id, requestedBy: new Types.ObjectId(actor.id), softwareId: software._id, versionId: version._id,
      previousSoftware: service.software ?? "", previousVersion: service.softwareVersion ?? "",
      requestedSoftware: software.identifier, requestedVersion: version.version, status: "backing-up", progress: 5, startedAt: new Date(),
    });
    try {
      const backup = await this.backups.create(serviceId, actor, "pre-update", "local");
      if (backup.status !== "completed") throw new BadRequestException("Pre-update backup failed; the existing service was not changed");
      operation.backupId = backup._id.toString();
      service.status = "updating"; await service.save();
      operation.status = "updating"; operation.progress = 25; await operation.save();
      agentNode = await this.nodes.get(service.nodeId.toString());
      agentUpgrade = await this.nodes.agentCall(agentNode, "/services/" + service._id.toString() + "/upgrade", {
        dockerImage, cpuPercent: service.cpuPercent, ramMb: service.ramMb, diskGb: service.diskGb,
        startupCommand: service.startupCommand ?? [], env: (software.installationConfig?.environment ?? {}) as Record<string, string>,
      }, "POST", 10 * 60 * 1000);
      operation.status = "verifying"; operation.progress = 85; await operation.save();
      if (agentUpgrade.status !== "online" || !agentUpgrade.running || agentUpgrade.installedImage !== dockerImage || !agentUpgrade.containerId || !agentUpgrade.previousContainerName) throw new BadRequestException("Node Agent did not verify the replacement container and retain the previous container for rollback");
      service.dockerImage = dockerImage; service.software = software.identifier; service.softwareVersion = version.version;
      service.containerId = agentUpgrade.containerId; service.status = "online";
      service.activity.push({ at: new Date(), action: "software.upgrade", ok: true, detail: software.identifier + "@" + version.version });
      await service.save(); serviceStateSaved = true;
      operation.status = "completed"; operation.progress = 100;
      operation.verification = { running: true, installedImage: agentUpgrade.installedImage, containerId: agentUpgrade.containerId, healthStatus: agentUpgrade.healthStatus ?? "unknown", previousContainerRemoved: false, previousContainerName: agentUpgrade.previousContainerName };
      operation.completedAt = new Date(); await operation.save();
      await this.audit.log({ actorId: actor.id, action: "software.service.upgraded", targetType: "service", targetId: serviceId, detail: operation._id.toString(), sensitive: true });
      // Finalize only after both the service record and operation record are safely saved.
      try {
        const committed = await this.nodes.agentCall(agentNode, "/services/" + service._id.toString() + "/upgrade-commit", { dockerImage, previousContainerName: agentUpgrade.previousContainerName }, "POST", 60_000) as { status?: string; previousContainerRemoved?: boolean };
        if (committed.status === "committed" && committed.previousContainerRemoved) operation.verification = { ...operation.verification, previousContainerRemoved: true };
        else operation.warning = "The new version is active, but the previous stopped container is still retained for administrator cleanup.";
      } catch { operation.warning = "The new version is active, but the previous stopped container could not be cleaned up. It was retained for safety."; }
      try { await operation.save(); } catch { /* The completed operation and service state are already saved; retain the old container if cleanup status cannot be recorded. */ }
      return operation;
    } catch (error) {
      const failureDetail = axios.isAxiosError(error) ? String(error.response?.data ?? error.message) : (error instanceof Error ? error.message : "Upgrade failed");
      let rollbackSucceeded = false;
      if (agentNode && agentUpgrade?.previousContainerName) {
        try {
          const rolledBack = await this.nodes.agentCall(agentNode, "/services/" + service._id.toString() + "/upgrade-rollback", { previousContainerName: agentUpgrade.previousContainerName }, "POST", 60_000) as { status?: string; running?: boolean };
          rollbackSucceeded = rolledBack.status === "rolled-back" && rolledBack.running === true;
        } catch { rollbackSucceeded = false; }
      }
      if (rollbackSucceeded || !serviceStateSaved) {
        service.dockerImage = previousState.dockerImage; service.software = previousState.software;
        service.softwareVersion = previousState.softwareVersion; service.containerId = previousState.containerId;
      }
      const rollbackNeedsAttention = (!!agentUpgrade && !rollbackSucceeded) || failureDetail.toLowerCase().includes("rollback needs administrator attention");
      service.status = rollbackNeedsAttention ? "error" : beforeStatus;
      service.activity.push({ at: new Date(), action: "software.upgrade.failed", ok: false, detail: failureDetail.slice(0, 300) });
      await service.save();
      operation.status = "failed"; operation.error = failureDetail.slice(0, 500); operation.completedAt = new Date(); await operation.save();
      await this.audit.log({ actorId: actor.id, action: "software.service.upgrade_failed", targetType: "service", targetId: serviceId, detail: operation._id.toString(), sensitive: true });
      throw error instanceof BadRequestException ? error : new BadRequestException(rollbackNeedsAttention ? "Upgrade failed and rollback could not be verified. The service was marked for administrator attention." : "Software upgrade failed. The previous confirmed software/version was retained.");
    }
  }
  async customerOptions(serviceId: string, actor: AuthUser) {
    const service = await this.services.get(serviceId, actor);
    if (["vps", "vds"].includes(service.type.toLowerCase())) return { serviceType: service.type, currentSoftware: service.software ?? null, currentVersion: service.softwareVersion ?? null, options: [] };
    const options = await this.catalog.find({ enabled: true, customerAvailable: true, serviceTypes: service.type }).lean();
    const output = await Promise.all(options.map(async (software) => ({
      software: { id: software._id, name: software.name, identifier: software.identifier, description: software.description, category: software.category, logoUrl: software.logoUrl, officialUrl: software.officialUrl, requiredRuntime: software.requiredRuntime, defaultVersion: software.defaultVersion, supportedOperatingSystems: software.supportedOperatingSystems, supportedArchitectures: software.supportedArchitectures, installable: software.installationConfig?.method === "docker-image-template" && typeof software.installationConfig?.imageTemplate === "string" && software.installationConfig.imageTemplate.includes("{version}") },
      versions: await this.versions.find({ softwareId: software._id, publicationStatus: "published", deprecated: false }).sort({ recommended: -1, releaseDate: -1 }).lean(),
    })));
    return { serviceType: service.type, currentSoftware: service.software ?? null, currentVersion: service.softwareVersion ?? null, options: output };
  }

  private async getSoftware(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException("Invalid software id");
    const software = await this.catalog.findById(id);
    if (!software) throw new NotFoundException("Software not found");
    return software;
  }

  private validateCatalogMetadata(input: Partial<Software>) {
    for (const [label, value] of [["official website", input.officialUrl], ["logo URL", input.logoUrl]] as const) {
      if (value === undefined || value === "") continue;
      let parsed: URL;
      try { parsed = new URL(value); } catch { throw new BadRequestException("Invalid " + label + " URL"); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new BadRequestException(label + " must be a valid HTTPS URL");
    }
    for (const [label, values] of [["supported operating systems", input.supportedOperatingSystems], ["supported architectures", input.supportedArchitectures]] as const) {
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.length > 30 || values.some(value => typeof value !== "string" || !/^[A-Za-z0-9._ -]{1,64}$/.test(value))) {
        throw new BadRequestException("Invalid " + label);
      }
    }
    if (input.requiredRuntime !== undefined && (typeof input.requiredRuntime !== "string" || input.requiredRuntime.length > 120)) throw new BadRequestException("Runtime requirement must be 120 characters or fewer");
    if (input.defaultVersion !== undefined && (typeof input.defaultVersion !== "string" || input.defaultVersion.length > 100)) throw new BadRequestException("Default version must be 100 characters or fewer");
  }

  private validateInstallation(config: Record<string, unknown>) {
    const method = typeof config.method === "string" ? config.method : "";
    const template = typeof config.imageTemplate === "string" ? config.imageTemplate : "";
    if (!method && !template) {
      if (config.environment !== undefined) throw new BadRequestException("Environment overrides require a Docker image-template installer");
      return;
    }
    const prefix = template.endsWith(":{version}") ? template.slice(0, -10) : "";
    if (method !== "docker-image-template" || !prefix || !/^[A-Za-z0-9._:/-]+$/.test(prefix)) throw new BadRequestException("Installation adapter must be a safe Docker image template ending in :{version}");
    const environment = config.environment ?? {};
    if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.keys(environment).length > 100) throw new BadRequestException("Installer environment must be an object with at most 100 entries");
    for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.length > 4096 || value.indexOf(String.fromCharCode(0)) !== -1) throw new BadRequestException("Installer environment contains an invalid key or value");
    }
  }

  private validateSource(type: string, config: Record<string, string>) {
    if (type === "github-releases" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) throw new BadRequestException("GitHub source requires an owner/repository");
    if (type === "modrinth" && !/^[A-Za-z0-9_-]{1,64}$/.test(config.projectId ?? "")) throw new BadRequestException("Modrinth source requires a project ID");
    if (["papermc-v3", "purpur-api"].includes(type) && !/^\d+\.\d+(?:\.\d+)?$/.test(config.minecraftVersion ?? "")) {
      throw new BadRequestException("Minecraft build sources require a valid Minecraft version such as 1.21.11");
    }
    if (type === "dockerhub-tags" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) throw new BadRequestException("Docker Hub source requires a namespace/repository");
    if (!["manual", "github-releases", "nodejs-index", "go-index", "mongodb-current", "papermc-v3", "purpur-api", "mojang-manifest", "fabric-meta", "forge-promotions", "modrinth", "dockerhub-tags"].includes(type)) throw new BadRequestException("Unsupported official source adapter");
  }

  private async fetchSource(software: SoftwareDocument): Promise<DiscoveredVersion[]> {
    if (software.sourceType === "github-releases") {
      const repo = software.sourceConfig.repository;
      const results: DiscoveredVersion[] = [];
      // GitHub's releases endpoint is page-based. Read a bounded number of
      // pages so large projects are not silently truncated at the first 500
      // releases, while keeping a single sync job within a predictable budget.
      const maxPages = 20;
      for (let page = 1; page <= maxPages; page++) {
        const response = await axios.get(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
          timeout: 20000, headers: { Accept: "application/vnd.github+json", "User-Agent": "NIMBUS-Software-Manager" },
        });
        if (!Array.isArray(response.data)) throw new BadRequestException("GitHub returned an invalid releases response");
        const rows = response.data as any[];
        for (const release of rows.filter((item: any) => !item.draft)) {
          const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
          if (!tag || tag.length > 100) continue;
          results.push({
            version: tag, releaseName: String(release.name ?? ""),
            releaseDate: release.published_at, prerelease: !!release.prerelease,
            sourceUrl: String(release.html_url ?? ""), sourceId: String(release.id ?? ""),
            metadata: { draft: !!release.draft, targetCommitish: String(release.target_commitish ?? "") },
          });
        }
        if (rows.length < 100) return results;
        if (page === maxPages) {
          throw new BadRequestException("GitHub release discovery reached its 2,000-release safety limit. Narrow the source repository or use a dedicated release feed.");
        }
      }
      return results;
    }
    if (software.sourceType === "nodejs-index") {
      const response = await axios.get("https://nodejs.org/dist/index.json", { timeout: 15000 });
      return (response.data as any[]).map((row) => ({
        version: String(row.version ?? "").replace(/^v/, ""), releaseDate: row.date, prerelease: !!row.lts === false && /-/.test(String(row.version)),
        sourceUrl: `https://nodejs.org/dist/${String(row.version ?? "").replace(/^v/, "")}/`,
        metadata: { lts: row.lts || false, npm: row.npm, v8: row.v8 },
      }));
    }
    if (software.sourceType === "go-index") {
      // Official Go distribution metadata includes checksums and per-platform
      // archives. Keep the full platform matrix in metadata so the admin can
      // review architecture support without guessing from a version string.
      const response = await axios.get("https://go.dev/dl/?mode=json&include=all", {
        timeout: 20000, headers: { Accept: "application/json", "User-Agent": "NIMBUS-Software-Manager" },
      });
      if (!Array.isArray(response.data)) throw new BadRequestException("Go returned an invalid release index");
      return (response.data as any[]).filter(row => typeof row.version === "string" && /^go[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(row.version)).map(row => {
        const files = Array.isArray(row.files) ? row.files : [];
        const linuxArchives = files.filter((file: any) => file.os === "linux" && file.kind === "archive");
        const supportedArchitectures = [...new Set<string>(linuxArchives.map((file: any) => String(file.arch ?? "")).filter(Boolean))];
        const linuxAmd64 = linuxArchives.find((file: any) => file.arch === "amd64");
        return {
          version: row.version.replace(/^go/, ""),
          releaseName: row.version,
          prerelease: row.stable === false,
          sourceUrl: linuxAmd64 ? "https://go.dev/dl/" + linuxAmd64.filename : "https://go.dev/dl/" + row.version + ".src.tar.gz",
          sourceId: row.version,
          compatibility: supportedArchitectures,
          metadata: {
            stable: row.stable === true,
            architectures: supportedArchitectures,
            files: files.filter((file: any) => file.os === "linux" && file.kind === "archive").map((file: any) => ({
              filename: String(file.filename ?? ""), architecture: String(file.arch ?? ""),
              sha256: String(file.sha256 ?? ""), size: Number(file.size ?? 0),
            })),
          },
        } as DiscoveredVersion;
      });
    }
    if (software.sourceType === "mojang-manifest") {
      const response = await axios.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", {
        timeout: 20000, headers: { Accept: "application/json", "User-Agent": "NIMBUS-Software-Manager/1.0" },
      });
      const rows = response.data?.versions;
      if (!Array.isArray(rows)) throw new BadRequestException("Mojang returned an invalid version manifest");
      return rows.filter(row => typeof row.id === "string" && row.id.length <= 100).map(row => ({
        version: row.id,
        releaseName: "Minecraft " + row.id,
        releaseDate: row.releaseTime,
        prerelease: row.type !== "release",
        sourceUrl: typeof row.url === "string" && row.url.startsWith("https://piston-meta.mojang.com/") ? row.url : "https://www.minecraft.net/",
        sourceId: row.id,
        compatibility: [row.id],
        metadata: { type: String(row.type ?? "unknown"), complianceLevel: Number(row.complianceLevel ?? 0) },
      }));
    }
    if (software.sourceType === "forge-promotions") {
      const response = await axios.get("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json", {
        timeout: 20000, headers: { Accept: "application/json", "User-Agent": "NIMBUS-Software-Manager/1.0" },
      });
      const promos = response.data?.promos;
      if (!promos || typeof promos !== "object" || Array.isArray(promos)) throw new BadRequestException("Forge returned an invalid promotions index");
      const grouped = new Map<string, { minecraftVersion: string; forgeVersion: string; promotions: Set<string> }>();
      for (const [key, value] of Object.entries(promos as Record<string, unknown>)) {
        const separator = key.lastIndexOf("-");
        if (separator <= 0 || !["latest", "recommended"].includes(key.slice(separator + 1))) continue;
        const minecraftVersion = key.slice(0, separator);
        const forgeVersion = String(value ?? "");
        if (!/^\\d+\\.\\d+(?:\\.\\d+)?$/.test(minecraftVersion) || !/^\\d+\\.\\d+(?:\\.\\d+)?$/.test(forgeVersion)) continue;
        const id = minecraftVersion + "-" + forgeVersion;
        const item = grouped.get(id) ?? { minecraftVersion, forgeVersion, promotions: new Set<string>() };
        item.promotions.add(key.slice(separator + 1));
        grouped.set(id, item);
      }
      return [...grouped.values()].map(item => {
        const id = item.minecraftVersion + "-" + item.forgeVersion;
        return {
          version: id,
          releaseName: "Forge " + item.minecraftVersion + " build " + item.forgeVersion,
          prerelease: false,
          sourceUrl: "https://maven.minecraftforge.net/net/minecraftforge/forge/" + id + "/forge-" + id + "-installer.jar",
          sourceId: id,
          compatibility: [item.minecraftVersion],
          metadata: { minecraftVersion: item.minecraftVersion, forgeVersion: item.forgeVersion, promotions: [...item.promotions] },
        } as DiscoveredVersion;
      });
    }
    if (software.sourceType === "fabric-meta") {
      const response = await axios.get("https://meta.fabricmc.net/v2/versions/game", {
        timeout: 20000, headers: { Accept: "application/json", "User-Agent": "NIMBUS-Software-Manager/1.0" },
      });
      if (!Array.isArray(response.data)) throw new BadRequestException("Fabric returned an invalid game-version list");
      return response.data.filter(row => typeof row.version === "string" && row.version.length <= 100).map(row => ({
        version: row.version,
        releaseName: "Fabric-compatible Minecraft " + row.version,
        prerelease: row.stable !== true,
        sourceUrl: "https://meta.fabricmc.net/v2/versions/game",
        sourceId: row.version,
        compatibility: [row.version],
        metadata: { stable: row.stable === true },
      }));
    }
    if (software.sourceType === "papermc-v3") {
      const minecraftVersion = software.sourceConfig.minecraftVersion;
      const response = await axios.get(
        "https://fill.papermc.io/v3/projects/paper/versions/" + encodeURIComponent(minecraftVersion) + "/builds",
        { timeout: 20000, headers: { Accept: "application/json", "User-Agent": "NIMBUS-Software-Manager/1.0" } },
      );
      if (!Array.isArray(response.data)) throw new BadRequestException("PaperMC returned an invalid build list");
      return (response.data as any[]).map(build => {
        const buildId = String(build.id ?? "");
        const download = build.downloads?.["server:default"];
        if (!/^\d+$/.test(buildId) || typeof download?.url !== "string" || !download.url.startsWith("https://")) return null;
        return {
          version: minecraftVersion + "-" + buildId,
          releaseName: "Paper " + minecraftVersion + " build " + buildId,
          releaseDate: build.time ?? build.createdAt,
          prerelease: String(build.channel ?? "").toUpperCase() !== "STABLE",
          sourceUrl: download.url,
          sourceId: buildId,
          compatibility: [minecraftVersion],
          metadata: {
            minecraftVersion, build: buildId, channel: String(build.channel ?? "UNKNOWN"),
            checksums: download?.checksums ?? {},
          },
        } as DiscoveredVersion;
      }).filter((item): item is DiscoveredVersion => item !== null);
    }
    if (software.sourceType === "purpur-api") {
      const minecraftVersion = software.sourceConfig.minecraftVersion;
      const response = await axios.get(
        "https://api.purpurmc.org/v2/purpur/" + encodeURIComponent(minecraftVersion),
        { timeout: 20000, headers: { Accept: "application/json", "User-Agent": "NIMBUS-Software-Manager/1.0" } },
      );
      const builds = response.data?.builds?.all;
      if (!Array.isArray(builds)) throw new BadRequestException("Purpur returned an invalid build list");
      const latest = String(response.data?.builds?.latest ?? "");
      return builds.filter((value: unknown) => /^\d+$/.test(String(value))).map((value: unknown) => {
        const buildId = String(value);
        return {
          version: minecraftVersion + "-" + buildId,
          releaseName: "Purpur " + minecraftVersion + " build " + buildId,
          prerelease: false,
          sourceUrl: "https://api.purpurmc.org/v2/purpur/" + encodeURIComponent(minecraftVersion) + "/" + buildId + "/download",
          sourceId: buildId,
          compatibility: [minecraftVersion],
          metadata: { minecraftVersion, build: buildId, latest: buildId === latest },
        } as DiscoveredVersion;
      });
    }
    if (software.sourceType === "mongodb-current") {
      // MongoDB's official current.json feed lists the current supported
      // release for each series. Keep Community (targeted) Linux packages only;
      // never mix Enterprise builds into a customer-facing catalog.
      const response = await axios.get("https://downloads.mongodb.org/current.json", {
        timeout: 30000, headers: { Accept: "application/json", "User-Agent": "NIMBUS-Software-Manager" },
      });
      const rows = (response.data as { versions?: any[] })?.versions;
      if (!Array.isArray(rows)) throw new BadRequestException("MongoDB returned an invalid current release index");
      return rows
        .filter(row => typeof row.version === "string" && /^\d+\.\d+\.\d+$/.test(row.version))
        .map(row => {
          const packages = (Array.isArray(row.downloads) ? row.downloads : []).filter((download: any) =>
            download.edition === "targeted" &&
            /^(ubuntu|debian)/.test(String(download.target ?? "")) &&
            ["x86_64", "aarch64"].includes(String(download.arch ?? "")) &&
            typeof download.archive?.url === "string" &&
            download.archive.url.startsWith("https://fastdl.mongodb.org/"),
          );
          if (!packages.length) return null;
          const preferred = packages.find((download: any) => download.target === "ubuntu2404" && download.arch === "x86_64")
            ?? packages.find((download: any) => download.arch === "x86_64")
            ?? packages[0];
          return {
            version: row.version,
            releaseName: "MongoDB " + row.version,
            releaseDate: row.date ? new Date(row.date).toISOString() : undefined,
            prerelease: row.development_release === true,
            sourceUrl: preferred.archive.url,
            sourceId: row.version,
            compatibility: [...new Set<string>(packages.map((download: any) => String(download.target) + "/" + String(download.arch)))],
            metadata: {
              developmentRelease: row.development_release === true,
              platforms: packages.map((download: any) => ({
                target: String(download.target), architecture: String(download.arch),
                url: String(download.archive.url), sha256: String(download.archive.sha256 ?? ""),
              })),
            },
          } as DiscoveredVersion;
        })
        .filter((item): item is DiscoveredVersion => item !== null);
    }
    if (software.sourceType === "dockerhub-tags") {
      const repository = software.sourceConfig.repository;
      const discovered: DiscoveredVersion[] = [];
      for (let page = 1; page <= 10; page++) {
        const response = await axios.get("https://hub.docker.com/v2/repositories/" + encodeURIComponent(repository.split("/")[0]) + "/" + encodeURIComponent(repository.split("/")[1]) + "/tags?page_size=100&page=" + page, { timeout: 15000, headers: { Accept: "application/json" } });
        const rows = (response.data as { results?: any[] }).results ?? [];
        discovered.push(...rows.filter(row => row.name && row.name !== "latest").map(row => ({
          version: String(row.name), releaseDate: row.last_updated, prerelease: /(alpha|beta|rc|preview|dev)/i.test(String(row.name)),
          sourceUrl: "https://hub.docker.com/r/" + repository + "/tags?name=" + encodeURIComponent(String(row.name)),
          sourceId: String(row.digest ?? row.id ?? ""),
          compatibility: Array.isArray(row.images) ? [...new Set<string>(row.images.map((image: any) => String(image.architecture ?? "")).filter(Boolean))] : [],
          metadata: { architectures: Array.isArray(row.images) ? [...new Set(row.images.map((image: any) => String(image.architecture ?? "")).filter(Boolean))] : [], os: Array.isArray(row.images) ? [...new Set<string>(row.images.map((image: any) => String(image.os ?? "")).filter(Boolean))] : [] },
        })));
        if (rows.length < 100) break;
      }
      return discovered;
    }
    if (software.sourceType === "modrinth") {
      const projectId = software.sourceConfig.projectId;
      const discovered: DiscoveredVersion[] = [];
      for (let offset = 0; offset < 1000; offset += 100) {
        const response = await axios.get(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?limit=100&offset=${offset}`, { timeout: 15000, headers: { "User-Agent": "NIMBUS/1.0 (software catalog)" } });
        const rows = response.data as any[];
        discovered.push(...rows.map((row) => ({
          version: String(row.version_number ?? ""), releaseName: String(row.name ?? ""),
          releaseDate: row.date_published, prerelease: row.version_type !== "release",
          sourceUrl: `https://modrinth.com/${projectId}/version/${String(row.id ?? "")}`, sourceId: String(row.id ?? ""),
          compatibility: Array.isArray(row.game_versions) ? row.game_versions : [],
          metadata: { loaders: row.loaders ?? [], versionType: row.version_type ?? "unknown" },
        })));
        if (rows.length < 100) break;
      }
      return discovered;
    }
    throw new BadRequestException("This software uses manual version management; no automatic source is configured");
  }
}
