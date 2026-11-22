import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import axios from "axios";
import { Model, Types } from "mongoose";
import { AuditService } from "../audit/audit.service";
import { ServicesService } from "../services/services.service";
import { AuthUser } from "../../common/auth.decorators";
import { Software, SoftwareDocument } from "./software.schema";
import { SoftwareVersion, SoftwareVersionDocument } from "./software-version.schema";

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
    @InjectModel(SoftwareVersion.name) private readonly versions: Model<SoftwareVersionDocument>,
    private readonly services: ServicesService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.syncTimer = setInterval(() => { void this.runDueSyncs(); }, 60_000);
    this.syncTimer.unref?.();
  }
  onModuleDestroy() { if (this.syncTimer) clearInterval(this.syncTimer); }
  list() { return this.catalog.find().sort({ name: 1 }).lean(); }
  private async runDueSyncs() {
    const rows = await this.catalog.find({ autoSync: true, syncFrequency: { $in: ["6h", "12h", "24h", "7d"] } }).select("_id syncFrequency lastSyncedAt").lean();
    const intervals: Record<string, number> = { "6h": 21600000, "12h": 43200000, "24h": 86400000, "7d": 604800000 };
    for (const row of rows) {
      const interval = intervals[row.syncFrequency] ?? 0;
      if (!interval || (row.lastSyncedAt && Date.now() - new Date(row.lastSyncedAt).getTime() < interval)) continue;
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
    const software = await this.catalog.create({
      name: input.name.trim(), identifier: input.identifier, description: input.description ?? "",
      category: input.category ?? "runtime", serviceTypes: [...new Set(input.serviceTypes)],
      sourceType: input.sourceType ?? "manual", sourceConfig: input.sourceConfig ?? {},
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
    const allowed = ["name", "description", "category", "serviceTypes", "sourceType", "sourceConfig", "enabled", "customerAvailable", "autoSync", "syncFrequency", "autoPublish"] as const;
    for (const key of allowed) if (input[key] !== undefined) (software as any)[key] = input[key];
    await software.save();
    await this.audit.log({ actorId: actor.id, action: "software.updated", targetType: "software", targetId: id, sensitive: true });
    return software;
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

  async discover(id: string, actor: AuthUser) {
    const software = await this.getSoftware(id);
    const startedAt = new Date();
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
      await this.audit.log({ actorId: actor.id, action: "software.versions.discovered", targetType: "software", targetId: id, detail: `discovered=${discovered.length} imported=${imported} skipped=${skipped} failed=${failed}`, sensitive: true });
      return { discovered: discovered.length, imported, skipped, failed, versions: discovered };
    } catch (error) {
      software.lastSyncStatus = "failed";
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

  async customerOptions(serviceId: string, actor: AuthUser) {
    const service = await this.services.get(serviceId, actor);
    if (["vps", "vds"].includes(service.type.toLowerCase())) return { serviceType: service.type, currentSoftware: service.software ?? null, currentVersion: service.softwareVersion ?? null, options: [] };
    const options = await this.catalog.find({ enabled: true, customerAvailable: true, serviceTypes: service.type }).lean();
    const output = await Promise.all(options.map(async (software) => ({
      software: { id: software._id, name: software.name, identifier: software.identifier, description: software.description, category: software.category },
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

  private validateSource(type: string, config: Record<string, string>) {
    if (type === "github-releases" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) throw new BadRequestException("GitHub source requires an owner/repository");
    if (type === "modrinth" && !/^[A-Za-z0-9_-]{1,64}$/.test(config.projectId ?? "")) throw new BadRequestException("Modrinth source requires a project ID");
    if (!["manual", "github-releases", "nodejs-index", "modrinth"].includes(type)) throw new BadRequestException("Unsupported official source adapter");
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
    if (software.sourceType === "modrinth") {
      const projectId = software.sourceConfig.projectId;
      const response = await axios.get(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?limit=100`, { timeout: 15000, headers: { "User-Agent": "NIMBUS/1.0 (software catalog)" } });
      return (response.data as any[]).map((row) => ({
        version: String(row.version_number ?? ""), releaseName: String(row.name ?? ""),
        releaseDate: row.date_published, prerelease: row.version_type !== "release",
        sourceUrl: `https://modrinth.com/${projectId}/version/${String(row.id ?? "")}`, sourceId: String(row.id ?? ""),
        compatibility: Array.isArray(row.game_versions) ? row.game_versions : [],
        metadata: { loaders: row.loaders ?? [], versionType: row.version_type ?? "unknown" },
      }));
    }
    throw new BadRequestException("This software uses manual version management; no automatic source is configured");
  }
}
