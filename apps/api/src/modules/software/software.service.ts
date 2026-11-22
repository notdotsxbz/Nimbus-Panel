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
    private readonly services: ServicesService,
    private readonly nodes: NodesService,
    private readonly backups: BackupsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.syncTimer = setInterval(() => { void this.runDueSyncs(); }, 60_000);
    this.syncTimer.unref?.();
  }
  onModuleDestroy() { if (this.syncTimer) clearInterval(this.syncTimer); }
  list() { return this.catalog.find().sort({ name: 1 }).lean(); }
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
    const software = await this.catalog.create({
      name: input.name.trim(), identifier: input.identifier, description: input.description ?? "",
      category: input.category ?? "runtime", serviceTypes: [...new Set(input.serviceTypes)],
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
    const allowed = ["name", "description", "category", "serviceTypes", "sourceType", "sourceConfig", "installationConfig", "enabled", "customerAvailable", "autoSync", "syncFrequency", "autoPublish"] as const;
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
    const version = await this.versions.findOne({ _id: versionId, softwareId: id });
    if (!version) throw new NotFoundException("Version not found");
    const inUse = await this.serviceRecords.countDocuments({ software: software.identifier, softwareVersion: version.version });
    if (inUse > 0) throw new BadRequestException("This version is currently used by " + inUse + " service(s) and cannot be deleted.");
    await version.deleteOne();
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
    const ids = versionIds.map(v => new Types.ObjectId(v));
    const update: Record<string, unknown> = {};
    if (action === "publish") update.publicationStatus = "published";
    else if (action === "disable") update.publicationStatus = "disabled";
    else if (action === "pending") update.publicationStatus = "pending";
    else if (action === "deprecate") update.deprecated = true;
    else if (action === "undeprecate") update.deprecated = false;
    else if (action === "recommend" && ids.length === 1) { await this.versions.updateMany({ softwareId: id }, { $set: { recommended: false } }); update.recommended = true; }
    else throw new BadRequestException("Unsupported bulk action");
    const result = await this.versions.updateMany({ softwareId: id, _id: { $in: ids } }, { $set: update });
    await this.audit.log({ actorId: actor.id, action: "software.versions.bulk_updated", targetType: "software", targetId: id, detail: "action=" + action + " modified=" + result.modifiedCount, sensitive: true });
    return { matched: result.matchedCount, modified: result.modifiedCount };
  }
  async setVersion(id: string, versionId: string, input: { publicationStatus?: string; deprecated?: boolean; recommended?: boolean }, actor: AuthUser) {
    await this.getSoftware(id);
    if (input.publicationStatus && !["pending", "published", "disabled"].includes(input.publicationStatus)) throw new BadRequestException("Invalid publication status");
    const version = await this.versions.findOne({ _id: versionId, softwareId: id });
    if (!version) throw new NotFoundException("Version not found");
    if (input.recommended) await this.versions.updateMany({ softwareId: id }, { $set: { recommended: false } });
    if (input.publicationStatus !== undefined) version.publicationStatus = input.publicationStatus;
    if (input.deprecated !== undefined) version.deprecated = input.deprecated;
    if (input.recommended !== undefined) version.recommended = input.recommended;
    await version.save();
    await this.audit.log({ actorId: actor.id, action: "software.version.updated", targetType: "software-version", targetId: versionId, sensitive: true });
    return version;
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
    if (software.installationConfig?.method !== "docker-image-template" || !template?.includes("{version}")) throw new BadRequestException("This catalog entry has no verified installation adapter yet");
    const safeVersion = version.version.replace(/[^A-Za-z0-9_.-]/g, "");
    if (!safeVersion || safeVersion !== version.version) throw new BadRequestException("The selected version cannot be safely used as a container tag");
    const dockerImage = template.replaceAll("{version}", safeVersion);
    if (!/^[A-Za-z0-9._:/@-]+$/.test(dockerImage)) throw new BadRequestException("Configured container image is invalid");
    const beforeStatus = service.status;
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
      const node = await this.nodes.get(service.nodeId.toString());
      const result = await this.nodes.agentCall(node, "/services/" + service._id.toString() + "/upgrade", {
        dockerImage, cpuPercent: service.cpuPercent, ramMb: service.ramMb, diskGb: service.diskGb,
        startupCommand: service.startupCommand ?? [], env: {},
      }, "POST", 10 * 60 * 1000) as { status?: string; containerId?: string; installedImage?: string; running?: boolean };
      operation.status = "verifying"; operation.progress = 85; await operation.save();
      if (result.status !== "online" || !result.running || result.installedImage !== dockerImage || !result.containerId) throw new BadRequestException("Node Agent did not verify the requested image and running container");
      service.dockerImage = dockerImage; service.software = software.identifier; service.softwareVersion = version.version;
      service.containerId = result.containerId; service.status = "online";
      service.activity.push({ at: new Date(), action: "software.upgrade", ok: true, detail: software.identifier + "@" + version.version });
      await service.save();
      operation.status = "completed"; operation.progress = 100; operation.verification = { running: true, installedImage: result.installedImage, containerId: result.containerId }; operation.completedAt = new Date(); await operation.save();
      await this.audit.log({ actorId: actor.id, action: "software.service.upgraded", targetType: "service", targetId: serviceId, detail: operation._id.toString(), sensitive: true });
      return operation;
    } catch (error) {
      const failureDetail = axios.isAxiosError(error) ? String(error.response?.data ?? error.message) : (error instanceof Error ? error.message : "Upgrade failed");
      const rollbackNeedsAttention = failureDetail.toLowerCase().includes("rollback needs administrator attention");
      service.status = rollbackNeedsAttention ? "error" : beforeStatus;
      service.activity.push({ at: new Date(), action: "software.upgrade.failed", ok: false, detail: failureDetail.slice(0, 300) });
      await service.save();
      operation.status = "failed"; operation.error = failureDetail.slice(0, 500); operation.completedAt = new Date(); await operation.save();
      await this.audit.log({ actorId: actor.id, action: "software.service.upgrade_failed", targetType: "service", targetId: serviceId, detail: operation._id.toString(), sensitive: true });
      throw error instanceof BadRequestException ? error : new BadRequestException(rollbackNeedsAttention ? "Upgrade failed and automatic rollback needs administrator attention. Contact support before retrying." : "Software upgrade failed. The previous confirmed software/version was retained.");
    }
  }
  async customerOptions(serviceId: string, actor: AuthUser) {
    const service = await this.services.get(serviceId, actor);
    if (["vps", "vds"].includes(service.type.toLowerCase())) return { serviceType: service.type, currentSoftware: service.software ?? null, currentVersion: service.softwareVersion ?? null, options: [] };
    const options = await this.catalog.find({ enabled: true, customerAvailable: true, serviceTypes: service.type }).lean();
    const output = await Promise.all(options.map(async (software) => ({
      software: { id: software._id, name: software.name, identifier: software.identifier, description: software.description, category: software.category, installable: software.installationConfig?.method === "docker-image-template" && !!software.installationConfig?.imageTemplate?.includes("{version}") },
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

  private validateInstallation(config: Record<string, string>) {
    if (!config.method && !config.imageTemplate) return;
    const template = config.imageTemplate ?? "";
    const prefix = template.endsWith(":{version}") ? template.slice(0, -10) : "";
    if (config.method !== "docker-image-template" || !prefix || !/^[A-Za-z0-9._:/-]+$/.test(prefix)) throw new BadRequestException("Installation adapter must be a safe Docker image template ending in :{version}");
  }

  private validateSource(type: string, config: Record<string, string>) {
    if (type === "github-releases" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) throw new BadRequestException("GitHub source requires an owner/repository");
    if (type === "modrinth" && !/^[A-Za-z0-9_-]{1,64}$/.test(config.projectId ?? "")) throw new BadRequestException("Modrinth source requires a project ID");
    if (type === "dockerhub-tags" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) throw new BadRequestException("Docker Hub source requires a namespace/repository");
    if (!["manual", "github-releases", "nodejs-index", "modrinth", "dockerhub-tags"].includes(type)) throw new BadRequestException("Unsupported official source adapter");
  }

  private async fetchSource(software: SoftwareDocument): Promise<DiscoveredVersion[]> {
    if (software.sourceType === "github-releases") {
      const repo = software.sourceConfig.repository;
      const results: DiscoveredVersion[] = [];
      for (let page = 1; page <= 5; page++) {
        const response = await axios.get(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
          timeout: 15000, headers: { Accept: "application/vnd.github+json", "User-Agent": "NIMBUS-Software-Manager" },
        });
        const rows = response.data as any[];
        for (const release of rows) results.push({
          version: String(release.tag_name ?? ""), releaseName: String(release.name ?? ""),
          releaseDate: release.published_at, prerelease: !!release.prerelease,
          sourceUrl: String(release.html_url ?? ""), sourceId: String(release.id ?? ""),
          metadata: { draft: !!release.draft },
        });
        if (rows.length < 100) break;
      }
      return results;
    }
    if (software.sourceType === "nodejs-index") {
      const response = await axios.get("https://nodejs.org/dist/index.json", { timeout: 15000 });
      return (response.data as any[]).map((row) => ({
        version: String(row.version ?? ""), releaseDate: row.date, prerelease: !!row.lts === false && /-/.test(String(row.version)),
        sourceUrl: `https://nodejs.org/dist/${String(row.version ?? "").replace(/^v/, "")}/`,
        metadata: { lts: row.lts || false, npm: row.npm, v8: row.v8 },
      }));
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
