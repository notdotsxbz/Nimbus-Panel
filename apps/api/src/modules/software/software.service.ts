import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import axios from "axios";
import { Model, Types } from "mongoose";
import { AuditService } from "../audit/audit.service";
import { ServicesService } from "../services/services.service";
import type { CreateServiceDto } from "../services/services.service";
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
  architectures?: string[];
  operatingSystems?: string[];
  compatible?: boolean;
  incompatibilityReasons?: string[];
  runtimeRequirements?: Record<string, unknown>;
  checksum?: string;
  signature?: string;
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

  async onModuleInit() {
    try { await this.seedDefaultCatalog(); }
    catch (error) { console.error("[software-catalog] preset seeding failed:", error instanceof Error ? error.message : "unknown error"); }
    // MongoDB-backed jobs survive API restarts. The timer only wakes the
    // scheduler/worker; job state, retries and leases are persisted.
    this.syncTimer = setInterval(() => { void this.runSyncQueue(); }, 15_000);
    this.syncTimer.unref?.();
    void this.runSyncQueue();
  }

  private async seedDefaultCatalog() {
    const presets: Partial<Software>[] = [
      { name: "Minecraft Vanilla", identifier: "minecraft-vanilla", description: "Official Mojang vanilla server versions. Admin review is required before customer availability.", category: "minecraft", serviceTypes: ["minecraft"], sourceType: "minecraft-manifest", officialWebsite: "https://www.minecraft.net/", installationConfig: { method: "docker-image-template", imageTemplate: "itzg/minecraft-server:java21", environment: { TYPE: "VANILLA", VERSION: "{version}", EULA: "TRUE" }, versionProbe: "minecraft-log" } },
      { name: "Minecraft Paper", identifier: "minecraft-paper", description: "PaperMC versions for Minecraft. Uses the official PaperMC project metadata and startup-log verification.", category: "minecraft", serviceTypes: ["minecraft"], sourceType: "papermc", sourceConfig: { project: "paper" }, officialWebsite: "https://papermc.io/", installationConfig: { method: "docker-image-template", imageTemplate: "itzg/minecraft-server:java21", environment: { TYPE: "PAPER", VERSION: "{version}", EULA: "TRUE" }, versionProbe: "minecraft-log" } },
      { name: "Minecraft Folia", identifier: "minecraft-folia", description: "Folia versions from the official PaperMC project metadata.", category: "minecraft", serviceTypes: ["minecraft"], sourceType: "papermc", sourceConfig: { project: "folia" }, officialWebsite: "https://papermc.io/software/folia", installationConfig: { method: "docker-image-template", imageTemplate: "itzg/minecraft-server:java21", environment: { TYPE: "FOLIA", VERSION: "{version}", EULA: "TRUE" }, versionProbe: "minecraft-log" } },
      { name: "Minecraft Purpur", identifier: "minecraft-purpur", description: "Purpur Minecraft versions from the official Purpur API.", category: "minecraft", serviceTypes: ["minecraft"], sourceType: "purpur", officialWebsite: "https://purpurmc.org/", installationConfig: { method: "docker-image-template", imageTemplate: "itzg/minecraft-server:java21", environment: { TYPE: "PURPUR", VERSION: "{version}", EULA: "TRUE" }, versionProbe: "minecraft-log" } },
      { name: "Minecraft Spigot", identifier: "minecraft-spigot", description: "Spigot-compatible Minecraft game versions. The container downloads the current compatible Spigot build for the selected game version.", category: "minecraft", serviceTypes: ["minecraft"], sourceType: "minecraft-manifest", officialWebsite: "https://www.spigotmc.org/", installationConfig: { method: "docker-image-template", imageTemplate: "itzg/minecraft-server:java21", environment: { TYPE: "SPIGOT", VERSION: "{version}", EULA: "TRUE" }, versionProbe: "minecraft-log" } },
      { name: "Minecraft Fabric", identifier: "minecraft-fabric", description: "Fabric game versions from the official Fabric Meta API.", category: "minecraft", serviceTypes: ["minecraft"], sourceType: "fabric-meta", officialWebsite: "https://fabricmc.net/", installationConfig: { method: "docker-image-template", imageTemplate: "itzg/minecraft-server:java21", environment: { TYPE: "FABRIC", VERSION: "{version}", EULA: "TRUE" }, versionProbe: "minecraft-log" } },
      { name: "Minecraft Quilt", identifier: "minecraft-quilt", description: "Quilt game versions from the official Quilt Meta API.", category: "minecraft", serviceTypes: ["minecraft"], sourceType: "quilt-meta", officialWebsite: "https://quiltmc.org/", installationConfig: { method: "docker-image-template", imageTemplate: "itzg/minecraft-server:java21", environment: { TYPE: "QUILT", VERSION: "{version}", EULA: "TRUE" }, versionProbe: "minecraft-log" } },
      { name: "Minecraft Forge", identifier: "minecraft-forge", description: "Official Forge Maven version metadata. This entry is catalog-only until an exact Forge installer and loader-version probe are configured.", category: "minecraft", serviceTypes: ["minecraft"], sourceType: "forge-maven", officialWebsite: "https://files.minecraftforge.net/", installationConfig: {} },
      { name: "Minecraft NeoForge", identifier: "minecraft-neoforge", description: "Official NeoForge Maven version metadata. This entry is catalog-only until an exact NeoForge installer and loader-version probe are configured.", category: "minecraft", serviceTypes: ["minecraft"], sourceType: "neoforge-maven", officialWebsite: "https://neoforged.net/", installationConfig: {} },
      { name: "Node.js Runtime", identifier: "runtime-nodejs", description: "Official Node.js release versions for Discord bots, websites and backends.", category: "runtime", serviceTypes: ["nodejs", "discord", "website", "backend"], sourceType: "nodejs-index", officialWebsite: "https://nodejs.org/", requiredRuntime: "Node.js", installationConfig: { method: "docker-image-template", imageTemplate: "node:{version}-alpine", versionProbe: "nodejs-version" } },
      { name: "Python Runtime", identifier: "runtime-python", description: "Official CPython releases for bots, websites and backends.", category: "runtime", serviceTypes: ["python", "discord", "website", "backend"], sourceType: "python-releases", officialWebsite: "https://www.python.org/", requiredRuntime: "Python", installationConfig: { method: "docker-image-template", imageTemplate: "python:{version}-slim", versionProbe: "python-version" } },
      { name: "PHP Runtime", identifier: "runtime-php", description: "Official PHP releases for websites and backends.", category: "runtime", serviceTypes: ["website", "backend"], sourceType: "php-releases", sourceConfig: { majorVersion: "8.4" }, officialWebsite: "https://www.php.net/", requiredRuntime: "PHP", installationConfig: { method: "docker-image-template", imageTemplate: "php:{version}-fpm", versionProbe: "php-version" } },
      { name: "Go Runtime", identifier: "runtime-go", description: "Official Go releases for backend applications.", category: "runtime", serviceTypes: ["backend"], sourceType: "go-index", officialWebsite: "https://go.dev/", requiredRuntime: "Go", installationConfig: { method: "docker-image-template", imageTemplate: "golang:{version}", versionProbe: "go-version" } },
      { name: ".NET Runtime", identifier: "runtime-dotnet", description: "Microsoft .NET 8 release channel for backend applications.", category: "runtime", serviceTypes: ["backend"], sourceType: "dotnet-index", sourceConfig: { channelVersion: "8.0" }, officialWebsite: "https://dotnet.microsoft.com/", requiredRuntime: ".NET", installationConfig: { method: "docker-image-template", imageTemplate: "mcr.microsoft.com/dotnet/aspnet:{version}", versionProbe: "dotnet-version" } },
      { name: "Java Runtime (Temurin)", identifier: "runtime-java-temurin", description: "Official Eclipse Temurin Java releases. Catalog-only until a matching container tag convention is verified.", category: "runtime", serviceTypes: ["backend"], sourceType: "java-adoptium", officialWebsite: "https://adoptium.net/", requiredRuntime: "Java", installationConfig: {} },
      { name: "MongoDB Server", identifier: "database-mongodb", description: "Official MongoDB community server releases. Catalog-only until per-service database credentials and health checks are configured.", category: "database", serviceTypes: ["mongodb", "database"], sourceType: "mongodb-releases", officialWebsite: "https://www.mongodb.com/", installationConfig: {} },
      { name: "PostgreSQL", identifier: "database-postgresql", description: "Official PostgreSQL container tags. Admin review required before customer visibility.", category: "database", serviceTypes: ["database"], sourceType: "dockerhub-tags", sourceConfig: { repository: "library/postgres" }, officialWebsite: "https://www.postgresql.org/", installationConfig: {} },
      { name: "MySQL", identifier: "database-mysql", description: "Official MySQL container tags. Admin review required before customer visibility.", category: "database", serviceTypes: ["database"], sourceType: "dockerhub-tags", sourceConfig: { repository: "library/mysql" }, officialWebsite: "https://www.mysql.com/", installationConfig: {} },
      { name: "MariaDB", identifier: "database-mariadb", description: "Official MariaDB container tags. Admin review required before customer visibility.", category: "database", serviceTypes: ["database"], sourceType: "dockerhub-tags", sourceConfig: { repository: "library/mariadb" }, officialWebsite: "https://mariadb.org/", installationConfig: {} },
      { name: "Redis", identifier: "database-redis", description: "Official Redis container tags. Admin review required before customer visibility.", category: "database", serviceTypes: ["database"], sourceType: "dockerhub-tags", sourceConfig: { repository: "library/redis" }, officialWebsite: "https://redis.io/", installationConfig: {} },
      { name: "Custom Docker Application", identifier: "custom-docker-app", description: "Admin-defined Docker application template. Configure a verified image, runtime settings and health/version checks before enabling customer access.", category: "application", serviceTypes: ["custom", "docker"], sourceType: "manual", installationConfig: {} },
      { name: "Lavalink", identifier: "audio-lavalink", description: "Official Lavalink releases for audio nodes. Catalog-only until per-service Lavalink credentials/configuration are generated securely.", category: "application", serviceTypes: ["lavalink"], sourceType: "lavalink-releases", officialWebsite: "https://lavalink.dev/", installationConfig: {} },
      { name: "Ubuntu 24.04 OS Image", identifier: "os-ubuntu-2404", description: "Admin-only KVM/libvirt OS image metadata. Applying an image remains unavailable until a virtualization provider is installed.", category: "operating-system", serviceTypes: ["vps", "vds"], sourceType: "manual", officialWebsite: "https://ubuntu.com/", supportedOperatingSystems: ["linux"], supportedArchitectures: ["amd64"], installationConfig: { method: "virtualization-image", provider: "kvm-libvirt", imageId: "kvm/ubuntu-2404", minRamMb: 1024, architecture: "amd64" } },
      { name: "Debian 12 OS Image", identifier: "os-debian-12", description: "Admin-only KVM/libvirt OS image metadata. Applying an image remains unavailable until a virtualization provider is installed.", category: "operating-system", serviceTypes: ["vps", "vds"], sourceType: "manual", officialWebsite: "https://www.debian.org/", supportedOperatingSystems: ["linux"], supportedArchitectures: ["amd64"], installationConfig: { method: "virtualization-image", provider: "kvm-libvirt", imageId: "kvm/debian-12", minRamMb: 1024, architecture: "amd64" } },
    ];
    for (const preset of presets) {
      await this.catalog.updateOne({ identifier: preset.identifier }, { $setOnInsert: { ...preset, enabled: true, customerAvailable: false, autoSync: false, autoPublish: false, syncFrequency: "manual", syncHistory: [] } }, { upsert: true });
    }
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
  async list() {
    const catalog = await this.catalog.find().sort({ name: 1 }).lean();
    if (!catalog.length) return catalog;
    const ids = catalog.map(item => item._id);
    const versions = await this.versions.find({ softwareId: { $in: ids } }).select("softwareId version recommended publicationStatus deprecated compatible releaseDate importedAt").sort({ releaseDate: -1, importedAt: -1 }).lean();
    const summary = new Map<string, { latestDiscoveredVersion: string | null; latestPublishedVersion: string | null; recommendedVersion: string | null; versionCount: number }>();
    for (const item of catalog) summary.set(item._id.toString(), { latestDiscoveredVersion: null, latestPublishedVersion: null, recommendedVersion: null, versionCount: 0 });
    for (const version of versions) {
      const entry = summary.get(version.softwareId.toString());
      if (!entry) continue;
      entry.versionCount++;
      if (!entry.latestDiscoveredVersion) entry.latestDiscoveredVersion = version.version;
      if (!entry.latestPublishedVersion && version.publicationStatus === "published" && !version.deprecated && version.compatible !== false) entry.latestPublishedVersion = version.version;
      if (version.recommended) entry.recommendedVersion = version.version;
    }
    return catalog.map(item => ({ ...item, ...summary.get(item._id.toString()) }));
  }

  listOperations() {
    return this.operations.find().sort({ createdAt: -1 }).limit(100).populate("serviceId", "name type").populate("softwareId", "name identifier").populate("requestedBy", "username").lean();
  }

  async create(input: Partial<Software>, actor: AuthUser) {
    if (!input.name?.trim() || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(input.identifier ?? "")) {
      throw new BadRequestException("Name and a valid lowercase identifier are required");
    }
    if (!Array.isArray(input.serviceTypes) || !input.serviceTypes.length) throw new BadRequestException("Choose at least one supported service type");
    this.validateSoftwareMetadata(input);
    this.validateSource(input.sourceType ?? "manual", input.sourceConfig ?? {});
    this.validateInstallation(input.installationConfig ?? {});
    const createFrequency = input.syncFrequency ?? "manual";
    if (!["manual", "6h", "12h", "24h", "7d"].includes(createFrequency)) throw new BadRequestException("Invalid sync frequency");
    if (input.autoSync && createFrequency === "manual") throw new BadRequestException("Choose a sync frequency when automatic sync is enabled");
    const software = await this.catalog.create({
      name: input.name.trim(), identifier: input.identifier, description: input.description ?? "",
      officialWebsite: input.officialWebsite ?? "", iconUrl: input.iconUrl ?? "",
      supportedOperatingSystems: input.supportedOperatingSystems ?? [], supportedArchitectures: input.supportedArchitectures ?? [],
      requiredRuntime: input.requiredRuntime ?? "", defaultVersion: input.defaultVersion ?? "",
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
    this.validateSoftwareMetadata(input);
    if (input.installationConfig) this.validateInstallation(input.installationConfig);
    const nextFrequency = input.syncFrequency ?? software.syncFrequency;
    const nextAutoSync = input.autoSync ?? software.autoSync;
    if (!["manual", "6h", "12h", "24h", "7d"].includes(nextFrequency)) throw new BadRequestException("Invalid sync frequency");
    if (nextAutoSync && nextFrequency === "manual") throw new BadRequestException("Choose a sync frequency when automatic sync is enabled");
    if (input.serviceTypes !== undefined && (!Array.isArray(input.serviceTypes) || !input.serviceTypes.length || input.serviceTypes.some(value => typeof value !== "string" || !/^[a-z0-9_-]{2,32}$/.test(value)))) throw new BadRequestException("Choose valid service types");
    const allowed = ["name", "description", "officialWebsite", "iconUrl", "supportedOperatingSystems", "supportedArchitectures", "requiredRuntime", "defaultVersion", "category", "serviceTypes", "sourceType", "sourceConfig", "installationConfig", "enabled", "customerAvailable", "autoSync", "syncFrequency", "autoPublish"] as const;
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
  async listVersions(id: string, requestedPage = 1, requestedLimit = 50) {
    await this.getSoftware(id);
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
    const filter = { softwareId: new Types.ObjectId(id) };
    const [items, total] = await Promise.all([
      this.versions.find(filter).sort({ releaseDate: -1, version: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.versions.countDocuments(filter),
    ]);
    return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
  }

  async addVersion(id: string, input: Partial<SoftwareVersion>, actor: AuthUser) {
    const software = await this.getSoftware(id);
    if (!input.version?.trim() || input.version.length > 100) throw new BadRequestException("A version identifier is required");
    if (input.sourceUrl) {
      try { const source = new URL(input.sourceUrl); if (source.protocol !== "https:") throw new Error("https required"); }
      catch { throw new BadRequestException("Version source URL must use HTTPS"); }
    }
    for (const key of ["architectures", "operatingSystems", "compatibility"] as const) {
      const values = input[key];
      if (values !== undefined && (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(value)))) throw new BadRequestException("Version compatibility metadata is invalid");
    }
    if (input.runtimeRequirements !== undefined && (!input.runtimeRequirements || typeof input.runtimeRequirements !== "object" || Array.isArray(input.runtimeRequirements) || JSON.stringify(input.runtimeRequirements).length > 4096)) throw new BadRequestException("Runtime requirements metadata is invalid");
    if (input.checksum !== undefined && (typeof input.checksum !== "string" || input.checksum.length > 256)) throw new BadRequestException("Checksum is too long");
    if (input.signature !== undefined && (typeof input.signature !== "string" || input.signature.length > 4096)) throw new BadRequestException("Signature metadata is too long");
    const existing = await this.versions.findOne({ softwareId: software._id, version: input.version.trim() });
    if (existing) throw new BadRequestException("That version already exists");
    const version = await this.versions.create({
      softwareId: software._id, version: input.version.trim(), releaseName: input.releaseName ?? "",
      releaseDate: input.releaseDate, channel: input.channel ?? "stable", prerelease: input.prerelease ?? false,
      recommended: false, deprecated: false, publicationStatus: "pending", sourceUrl: input.sourceUrl ?? "",
      compatibility: input.compatibility ?? [], architectures: input.architectures ?? [], operatingSystems: input.operatingSystems ?? [],
      compatible: input.compatible ?? this.assessCompatibility(software, input).compatible,
      incompatibilityReasons: input.incompatibilityReasons ?? this.assessCompatibility(software, input).incompatibilityReasons,
      runtimeRequirements: input.runtimeRequirements ?? {}, checksum: input.checksum ?? "", signature: input.signature ?? "", metadata: input.metadata ?? {}, importedAt: new Date(),
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
    const preview = [...unique.values()].map(item => ({ ...item, ...this.assessCompatibility(software, item), alreadyImported: existingSet.has(item.version) }));
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
        if (!item.version || item.version.length > 100) { failed++; continue; }
        const compatibility = this.assessCompatibility(software, item);
        const result = await this.versions.updateOne({ softwareId: software._id, version: item.version }, { $setOnInsert: {
          softwareId: software._id, version: item.version, releaseName: item.releaseName ?? "", releaseDate: item.releaseDate ? new Date(item.releaseDate) : undefined,
          channel: item.prerelease ? "prerelease" : "stable", prerelease: !!item.prerelease, publicationStatus: software.autoPublish && !item.prerelease && item.compatible !== false && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(item.version) && typeof item.sourceUrl === "string" && item.sourceUrl.startsWith("https://") && item.metadata?.incomplete !== true ? "published" : "pending",
          sourceUrl: item.sourceUrl ?? "", sourceId: item.sourceId ?? "", compatibility: item.compatibility ?? [],
          architectures: item.architectures ?? [], operatingSystems: item.operatingSystems ?? [],
          ...this.assessCompatibility(software, item), runtimeRequirements: item.runtimeRequirements ?? {},
          checksum: item.checksum ?? (typeof item.metadata?.checksum === "string" ? item.metadata.checksum : ""), signature: item.signature ?? "",
          metadata: item.metadata ?? {}, importedAt: new Date(),
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
          const compatibility = this.assessCompatibility(software, item);
          const result = await this.versions.updateOne(
            { softwareId: software._id, version: item.version },
            { $setOnInsert: {
              softwareId: software._id, version: item.version, releaseName: item.releaseName ?? "",
              releaseDate: item.releaseDate ? new Date(item.releaseDate) : undefined,
              channel: item.prerelease ? "prerelease" : "stable", prerelease: !!item.prerelease,
              publicationStatus: software.autoPublish && !item.prerelease && compatibility.compatible && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(item.version) && typeof item.sourceUrl === "string" && item.sourceUrl.startsWith("https://") && item.metadata?.incomplete !== true ? "published" : "pending",
              sourceUrl: item.sourceUrl ?? "", sourceId: item.sourceId ?? "",
              compatibility: item.compatibility ?? [], architectures: item.architectures ?? [], operatingSystems: item.operatingSystems ?? [],
              ...this.assessCompatibility(software, item), runtimeRequirements: item.runtimeRequirements ?? {},
              checksum: item.checksum ?? (typeof item.metadata?.checksum === "string" ? item.metadata.checksum : ""), signature: item.signature ?? "", metadata: item.metadata ?? {}, importedAt: new Date(),
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
      await this.audit.log({ actorId: actor.id === "system" ? undefined : actor.id, action: "software.sync.failed", targetType: "software", targetId: id, detail: error instanceof Error ? error.message.slice(0, 500) : "Source request failed", sensitive: true });
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
    if (action === "publish") {
      const incompatibleCount = await this.versions.countDocuments({ softwareId: id, _id: { $in: ids }, compatible: false });
      if (incompatibleCount) throw new BadRequestException("Incompatible versions cannot be published to customers");
      update.publicationStatus = "published";
    }
    else if (action === "disable") update.publicationStatus = "disabled";
    else if (action === "pending") update.publicationStatus = "pending";
    else if (action === "deprecate") update.deprecated = true;
    else if (action === "undeprecate") update.deprecated = false;
    else if (action === "recommend" && ids.length === 1) { await this.versions.updateMany({ softwareId: id }, { $set: { recommended: false } }); await this.catalog.updateOne({ _id: id }, { $set: { recommendedVersionId: ids[0] } }); update.recommended = true; }
    else throw new BadRequestException("Unsupported bulk action");
    const result = await this.versions.updateMany({ softwareId: id, _id: { $in: ids } }, { $set: update });
    await this.audit.log({ actorId: actor.id, action: "software.versions.bulk_updated", targetType: "software", targetId: id, detail: "action=" + action + " modified=" + result.modifiedCount, sensitive: true });
    return { matched: result.matchedCount, modified: result.modifiedCount };
  }
  async setVersion(id: string, versionId: string, input: Partial<SoftwareVersion> & { publicationStatus?: string; deprecated?: boolean; recommended?: boolean }, actor: AuthUser) {
    const software = await this.getSoftware(id);
    if (input.publicationStatus && !["pending", "published", "disabled"].includes(input.publicationStatus)) throw new BadRequestException("Invalid publication status");
    const version = await this.versions.findById(versionId);
    if (!version || version.softwareId.toString() !== software._id.toString()) throw new NotFoundException("Version not found");
    if (input.releaseName !== undefined) version.releaseName = String(input.releaseName).slice(0, 200);
    if (input.releaseDate !== undefined) {
      const date = input.releaseDate ? new Date(input.releaseDate) : undefined;
      if (date && Number.isNaN(date.getTime())) throw new BadRequestException("Invalid release date");
      version.releaseDate = date;
    }
    if (input.channel !== undefined) version.channel = String(input.channel).slice(0, 40);
    if (input.prerelease !== undefined) version.prerelease = !!input.prerelease;
    if (input.sourceUrl !== undefined) {
      if (input.sourceUrl) { try { const url = new URL(input.sourceUrl); if (url.protocol !== "https:") throw new Error("https required"); } catch { throw new BadRequestException("Version source URL must use HTTPS"); } }
      version.sourceUrl = input.sourceUrl;
    }
    for (const key of ["architectures", "operatingSystems", "compatibility"] as const) {
      if (input[key] !== undefined) {
        const values = input[key] as string[];
        if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(value))) throw new BadRequestException("Version compatibility metadata is invalid");
        (version as any)[key] = values;
      }
    }
    if (input.runtimeRequirements !== undefined) {
      if (!input.runtimeRequirements || typeof input.runtimeRequirements !== "object" || Array.isArray(input.runtimeRequirements) || JSON.stringify(input.runtimeRequirements).length > 4096) throw new BadRequestException("Runtime requirements metadata is invalid");
      version.runtimeRequirements = input.runtimeRequirements;
    }
    if (input.checksum !== undefined) { if (typeof input.checksum !== "string" || input.checksum.length > 256) throw new BadRequestException("Checksum is too long"); version.checksum = input.checksum; }
    if (input.signature !== undefined) { if (typeof input.signature !== "string" || input.signature.length > 4096) throw new BadRequestException("Signature metadata is too long"); version.signature = input.signature; }
    const assessment = this.assessCompatibility(software, version);
    version.compatible = assessment.compatible;
    version.incompatibilityReasons = assessment.incompatibilityReasons;
    if (input.publicationStatus === "published" && version.compatible === false) throw new BadRequestException("Incompatible versions cannot be published to customers");
    if (input.recommended) { await this.versions.updateMany({ softwareId: id }, { $set: { recommended: false } }); await this.catalog.updateOne({ _id: id }, { $set: { recommendedVersionId: version._id } }); }
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
  async createServiceFromCatalog(input: Omit<CreateServiceDto, "dockerImage" | "software" | "softwareVersion" | "versionProbe" | "expectedVersion"> & { softwareId: string; versionId: string }, actor: AuthUser) {
    const serviceType = String(input.type ?? "").toLowerCase();
    if (["vps", "vds"].includes(serviceType)) throw new BadRequestException("VPS/VDS OS provisioning requires the unavailable KVM/libvirt provider");
    if (!Types.ObjectId.isValid(input.softwareId) || !Types.ObjectId.isValid(input.versionId)) throw new BadRequestException("Choose a valid catalog software and version");
    const [software, version] = await Promise.all([this.catalog.findById(input.softwareId), this.versions.findOne({ _id: input.versionId, softwareId: input.softwareId })]);
    if (!software || !version) throw new NotFoundException("Software or version not found");
    if (!software.enabled || !software.serviceTypes.includes(serviceType)) throw new BadRequestException("This software is not enabled for the selected service type");
    if (version.publicationStatus !== "published" || version.deprecated || version.compatible === false) throw new BadRequestException("Choose a published, non-deprecated and compatible version");
    const config = software.installationConfig ?? {};
    const template = config.imageTemplate;
    const environment = (config.environment ?? {}) as Record<string, string>;
    const hasImageVersion = typeof template === "string" && template.includes("{version}");
    const hasEnvironmentVersion = Object.values(environment).some(value => typeof value === "string" && value.includes("{version}"));
    if (config.method !== "docker-image-template" || typeof template !== "string" || (!hasImageVersion && !hasEnvironmentVersion)) throw new BadRequestException("This catalog entry has no verified Docker installation adapter");
    const safeVersion = version.version.replace(/[^A-Za-z0-9_.-]/g, "");
    if (!safeVersion || safeVersion !== version.version) throw new BadRequestException("The selected version cannot be safely used in a container tag");
    const dockerImage = template.replaceAll("{version}", safeVersion);
    if (!/^[A-Za-z0-9._:/@-]+$/.test(dockerImage)) throw new BadRequestException("Configured container image is invalid");
    const resolvedEnvironment = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value.replaceAll("{version}", safeVersion)]));
    const versionProbe = typeof config.versionProbe === "string" ? config.versionProbe : "";
    if (hasEnvironmentVersion && !hasImageVersion && !versionProbe) throw new BadRequestException("This installer requires a version verification probe");
    const startedAt = new Date();
    const result = await this.services.create({ ...input, dockerImage, envVars: resolvedEnvironment, software: software.identifier, softwareVersion: version.version, versionProbe, expectedVersion: versionProbe === "java-version" ? safeVersion.split("+")[0] : safeVersion }, actor);
    const completedAt = new Date();
    const installSucceeded = result.status === "online";
    await this.operations.create({
      serviceId: result._id, requestedBy: new Types.ObjectId(actor.id), softwareId: software._id, versionId: version._id,
      previousSoftware: "", previousVersion: "", requestedSoftware: software.identifier, requestedVersion: version.version,
      status: installSucceeded ? "completed" : "failed", progress: installSucceeded ? 100 : 0,
      error: installSucceeded ? "" : "Initial installation did not complete; service status: " + result.status,
      warning: versionProbe ? "" : "Container/image verified without an application-specific version probe",
      verification: { containerId: result.containerId ?? "", installedImage: dockerImage, containerRunning: installSucceeded, versionProbe: versionProbe || null, versionVerified: versionProbe ? installSucceeded : null },
      startedAt, completedAt,
    });
    await this.audit.log({ actorId: actor.id, action: "software.service.initial_install_requested", targetType: "service", targetId: result._id.toString(), detail: software.identifier + "@" + version.version + " status=" + result.status, sensitive: true });
    return result;
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
    if (version.compatible === false) throw new BadRequestException("This software version is incompatible with the configured service platform");
    const template = software.installationConfig?.imageTemplate;
    const configuredEnvironment = (software.installationConfig?.environment ?? {}) as Record<string, string>;
    const hasImageVersion = typeof template === "string" && template.includes("{version}");
    const hasEnvironmentVersion = Object.values(configuredEnvironment).some(value => typeof value === "string" && value.includes("{version}"));
    if (software.installationConfig?.method !== "docker-image-template" || typeof template !== "string" || (!hasImageVersion && !hasEnvironmentVersion)) throw new BadRequestException("This catalog entry has no verified installation adapter yet");
    const safeVersion = version.version.replace(/[^A-Za-z0-9_.-]/g, "");
    if (!safeVersion || safeVersion !== version.version) throw new BadRequestException("The selected version cannot be safely used as a container tag");
    const dockerImage = template.replaceAll("{version}", safeVersion);
    if (!/^[A-Za-z0-9._:/@-]+$/.test(dockerImage)) throw new BadRequestException("Configured container image is invalid");
    const resolvedEnvironment = Object.fromEntries(Object.entries(configuredEnvironment).map(([key, value]) => [key, value.replaceAll("{version}", safeVersion)]));
    const versionProbe = software.installationConfig?.versionProbe ?? "";
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
        startupCommand: service.startupCommand ?? [], env: resolvedEnvironment,
        versionProbe, expectedVersion: versionProbe === "java-version" ? safeVersion.split("+")[0] : safeVersion,
      }, "POST", 10 * 60 * 1000);
      operation.status = "verifying"; operation.progress = 85; await operation.save();
      if (agentUpgrade.status !== "online" || !agentUpgrade.running || agentUpgrade.installedImage !== dockerImage || !agentUpgrade.containerId || !agentUpgrade.previousContainerName || (versionProbe !== "" && agentUpgrade.versionVerified !== true) || (Object.keys(resolvedEnvironment).length > 0 && agentUpgrade.environmentVerified !== true)) throw new BadRequestException("Node Agent did not verify the requested application version, replacement container, and rollback state");
      service.dockerImage = dockerImage; service.software = software.identifier; service.softwareVersion = version.version;
      service.containerId = agentUpgrade.containerId; service.status = "online";
      service.activity.push({ at: new Date(), action: "software.upgrade", ok: true, detail: software.identifier + "@" + version.version });
      await service.save(); serviceStateSaved = true;
      operation.status = "completed"; operation.progress = 100;
      operation.verification = { running: true, installedImage: agentUpgrade.installedImage, containerId: agentUpgrade.containerId, healthStatus: agentUpgrade.healthStatus ?? "unknown", environmentVerified: agentUpgrade.environmentVerified === true, versionVerified: versionProbe ? agentUpgrade.versionVerified === true : undefined, previousContainerRemoved: false, previousContainerName: agentUpgrade.previousContainerName };
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
    const [latestSuccess, output] = await Promise.all([
      this.operations.findOne({ serviceId: service._id, status: "completed" }).sort({ completedAt: -1 }).select("completedAt").lean(),
      Promise.all(options.map(async (software) => ({
        software: {
          id: software._id, name: software.name, identifier: software.identifier, description: software.description,
          category: software.category, officialWebsite: software.officialWebsite, iconUrl: software.iconUrl,
          supportedOperatingSystems: software.supportedOperatingSystems, supportedArchitectures: software.supportedArchitectures,
          requiredRuntime: software.requiredRuntime, defaultVersion: software.defaultVersion,
          installable: software.installationConfig?.method === "docker-image-template" && typeof software.installationConfig?.imageTemplate === "string" && (software.installationConfig.imageTemplate.includes("{version}") || Object.values((software.installationConfig.environment ?? {}) as Record<string, string>).some(value => typeof value === "string" && value.includes("{version}"))),
        },
        versions: await this.versions.find({ softwareId: software._id, publicationStatus: "published", deprecated: false, compatible: { $ne: false } }).sort({ recommended: -1, releaseDate: -1 }).lean(),
      }))),
    ]);
    return { serviceType: service.type, currentSoftware: service.software ?? null, currentVersion: service.softwareVersion ?? null, lastSuccessfulUpdate: latestSuccess?.completedAt ?? null, options: output };
  }

  private async getSoftware(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException("Invalid software id");
    const software = await this.catalog.findById(id);
    if (!software) throw new NotFoundException("Software not found");
    return software;
  }

  private assessCompatibility(software: Software, item: { architectures?: string[]; operatingSystems?: string[]; runtimeRequirements?: Record<string, unknown> }) {
    const reasons: string[] = [];
    const normalize = (value: string) => {
      const lower = value.toLowerCase().replace("x86_64", "amd64").replace("x64", "amd64").replace("aarch64", "arm64");
      if (["ubuntu", "debian", "fedora", "centos", "rhel", "alpine", "linux"].some(os => lower.startsWith(os))) return "linux";
      if (lower.startsWith("win")) return "windows";
      if (lower.startsWith("darwin") || lower.startsWith("mac")) return "macos";
      return lower;
    };
    const supportedArchitectures = (software.supportedArchitectures ?? []).map(normalize);
    const availableArchitectures = (item.architectures ?? []).map(normalize);
    if (supportedArchitectures.length && availableArchitectures.length && !availableArchitectures.some(value => supportedArchitectures.includes(value))) reasons.push("No matching supported CPU architecture");
    const supportedOS = (software.supportedOperatingSystems ?? []).map(normalize);
    const availableOS = (item.operatingSystems ?? []).map(normalize);
    if (supportedOS.length && availableOS.length && !availableOS.some(value => supportedOS.some(supported => value === supported || value.startsWith(supported) || supported.startsWith(value)))) reasons.push("No matching supported operating system");
    if (software.requiredRuntime && item.runtimeRequirements) {
      const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
      const required = compact(software.requiredRuntime);
      const values = Object.entries(item.runtimeRequirements).map(([key, value]) => compact(key + String(value)));
      if (values.length && !values.some(value => value.includes(required))) reasons.push("Runtime requirements do not match the configured runtime");
    }
    return { compatible: reasons.length === 0, incompatibilityReasons: reasons };
  }

  private validateSoftwareMetadata(input: Partial<Software>) {
    for (const key of ["officialWebsite", "iconUrl"] as const) {
      const value = input[key];
      if (value === undefined || value === "") continue;
      if (typeof value !== "string" || value.length > 2048) throw new BadRequestException("Software website and icon URLs must be valid HTTPS URLs");
      try { const url = new URL(value); if (url.protocol !== "https:") throw new Error("https required"); }
      catch { throw new BadRequestException("Software website and icon URLs must be valid HTTPS URLs"); }
    }
    for (const key of ["supportedOperatingSystems", "supportedArchitectures"] as const) {
      const values = input[key];
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(value))) throw new BadRequestException("Software platform compatibility values are invalid");
    }
    if (input.requiredRuntime !== undefined && (typeof input.requiredRuntime !== "string" || input.requiredRuntime.length > 128)) throw new BadRequestException("Required runtime must be 128 characters or fewer");
    if (input.defaultVersion !== undefined && (typeof input.defaultVersion !== "string" || input.defaultVersion.length > 100)) throw new BadRequestException("Default version must be 100 characters or fewer");
  }

  private validateInstallation(config: Record<string, unknown>) {
    const method = typeof config.method === "string" ? config.method : "";
    const template = typeof config.imageTemplate === "string" ? config.imageTemplate : "";
    if (!method && !template) {
      if (config.environment !== undefined) throw new BadRequestException("Environment overrides require a Docker image-template installer");
      return;
    }
    if (method === "virtualization-image") {
      const provider = config.provider;
      const imageId = config.imageId;
      const minRamMb = config.minRamMb;
      const architecture = config.architecture;
      if (provider !== "kvm-libvirt" || typeof imageId !== "string" || !/^kvm\/[A-Za-z0-9._-]{2,80}$/.test(imageId)) throw new BadRequestException("OS templates must use an approved KVM/libvirt image identifier");
      if (!Number.isInteger(minRamMb) || Number(minRamMb) < 512 || Number(minRamMb) > 262144) throw new BadRequestException("OS template minimum RAM must be between 512 and 262144 MB");
      if (architecture !== undefined && !["amd64", "arm64"].includes(String(architecture))) throw new BadRequestException("Unsupported OS image architecture");
      return;
    }
    const normalizedImage = template.replaceAll("{version}", "version");
    const environment = config.environment ?? {};
    if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.keys(environment).length > 100) throw new BadRequestException("Installer environment must be an object with at most 100 entries");
    let environmentHasVersion = false;
    for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.length > 4096 || value.indexOf(String.fromCharCode(0)) !== -1) throw new BadRequestException("Installer environment contains an invalid key or value");
      if (value.includes("{version}")) environmentHasVersion = true;
    }
    const imageHasVersion = template.includes("{version}");
    const versionProbe = config.versionProbe;
    const supportedVersionProbes = ["minecraft-log", "nodejs-version", "python-version", "php-version", "go-version", "java-version", "dotnet-version", "mongodb-version"];
    if (typeof versionProbe === "string" && versionProbe !== "" && !supportedVersionProbes.includes(versionProbe)) throw new BadRequestException("Unsupported application version verification probe");
    if (versionProbe === "minecraft-log" && !((environment as Record<string, unknown>).VERSION as string | undefined)?.includes("{version}")) throw new BadRequestException("Minecraft log verification requires VERSION={version} in the installer environment");
    if (environmentHasVersion && !imageHasVersion && !versionProbe) throw new BadRequestException("Environment-based version placeholders require an application version verification probe");
    if (method !== "docker-image-template" || !template || !/^[A-Za-z0-9._:/-]+$/.test(normalizedImage) || (!imageHasVersion && !environmentHasVersion)) {
      throw new BadRequestException("Installer must use a safe Docker image template or a version placeholder in its environment");
    }
  }

  private validateSource(type: string, config: Record<string, string>) {
    if (type === "github-releases" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) throw new BadRequestException("GitHub source requires an owner/repository");
    if (type === "modrinth" && !/^[A-Za-z0-9_-]{1,64}$/.test(config.projectId ?? "")) throw new BadRequestException("Modrinth source requires a project ID");
    if (type === "dockerhub-tags" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) throw new BadRequestException("Docker Hub source requires a namespace/repository");
    if (type === "dotnet-index" && !/^\d+\.\d+$/.test(config.channelVersion ?? "")) throw new BadRequestException(".NET source requires a channel version such as 8.0 or 10.0");
    if (type === "php-releases" && config.majorVersion && !/^\d{1,2}(?:\.\d{1,2})?$/.test(config.majorVersion)) throw new BadRequestException("PHP release line must look like 8 or 8.4");
    if (type === "papermc" && !["paper", "folia", "velocity", "waterfall"].includes(config.project ?? "paper")) throw new BadRequestException("Unsupported PaperMC project");
    if (type === "purpur" && config.project && config.project !== "purpur") throw new BadRequestException("Purpur source project must be purpur");
    if (!["manual", "github-releases", "minecraft-manifest", "nodejs-index", "modrinth", "dockerhub-tags", "go-index", "dotnet-index", "papermc", "purpur", "fabric-meta", "quilt-meta", "java-adoptium", "forge-maven", "neoforge-maven", "python-releases", "php-releases", "lavalink-releases", "mongodb-releases"].includes(type)) throw new BadRequestException("Unsupported official source adapter");
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
        for (const release of rows.filter((item: any) => !item.draft)) results.push({
          version: String(release.tag_name ?? ""), releaseName: String(release.name ?? ""),
          releaseDate: release.published_at, prerelease: !!release.prerelease,
          sourceUrl: String(release.html_url ?? ""), sourceId: String(release.id ?? ""),
          metadata: { draft: !!release.draft },
        });
        if (rows.length < 100) break;
      }
      return results;
    }
    if (software.sourceType === "minecraft-manifest") {
      const response = await axios.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", { timeout: 20000, headers: { Accept: "application/json" } });
      const rows = (response.data as any).versions;
      if (!Array.isArray(rows)) throw new BadRequestException("Mojang version manifest returned an invalid response");
      return rows.map((row: any) => ({
        version: String(row.id ?? ""), releaseDate: row.releaseTime,
        prerelease: row.type !== "release", sourceUrl: String(row.url ?? "https://www.minecraft.net/en-us/download/server"),
        checksum: String(row.sha1 ?? ""), metadata: { type: row.type, sha1: row.sha1, manifestUrl: "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json" },
      }));
    }
    if (software.sourceType === "nodejs-index") {
      const response = await axios.get("https://nodejs.org/dist/index.json", { timeout: 15000 });
      return (response.data as any[]).map((row) => ({
        version: String(row.version ?? "").replace(/^v/, ""), releaseDate: row.date, prerelease: /-/.test(String(row.version ?? "")),
        sourceUrl: `https://nodejs.org/dist/${String(row.version ?? "").replace(/^v/, "")}/`,
        metadata: { lts: row.lts || false, npm: row.npm, v8: row.v8 },
      }));
    }
    if (software.sourceType === "go-index") {
      const response = await axios.get("https://go.dev/dl/?mode=json&include=all", { timeout: 20000, headers: { Accept: "application/json" } });
      if (!Array.isArray(response.data)) throw new BadRequestException("Go release source returned an invalid response");
      return response.data.filter((row: any) => typeof row.version === "string").map((row: any) => ({
        version: String(row.version).replace(/^go/, ""), prerelease: row.stable !== true,
        sourceUrl: "https://go.dev/dl/" + String(row.version),
        architectures: Array.isArray(row.files) ? [...new Set<string>(row.files.map((file: any) => String(file.arch ?? "")).filter(Boolean))] : [],
        operatingSystems: Array.isArray(row.files) ? [...new Set<string>(row.files.map((file: any) => String(file.os ?? "").toLowerCase()).filter(Boolean))] : [],
        checksum: Array.isArray(row.files) ? String(row.files.find((file: any) => file.kind === "archive" && file.sha256)?.sha256 ?? "") : "",
        metadata: { officialVersion: row.version, stable: row.stable === true, files: Array.isArray(row.files) ? row.files.map((file: any) => ({ os: file.os, arch: file.arch, kind: file.kind, filename: file.filename, sha256: file.sha256 })) : [] },
      }));
    }
    if (software.sourceType === "dotnet-index") {
      const channelVersion = software.sourceConfig.channelVersion;
      const response = await axios.get("https://builds.dotnet.microsoft.com/dotnet/release-metadata/" + encodeURIComponent(channelVersion) + "/releases.json", { timeout: 20000, headers: { Accept: "application/json" } });
      const rows = (response.data as any).releases;
      if (!Array.isArray(rows)) throw new BadRequestException(".NET release source returned an invalid response");
      return rows.filter((row: any) => typeof row["release-version"] === "string").map((row: any) => ({
        version: String(row["release-version"]), releaseDate: row["release-date"],
        sourceUrl: String(row["release-notes"] ?? "https://dotnet.microsoft.com/download/dotnet"),
        metadata: { channelVersion, sdkVersion: row.sdk?.version, runtimeVersion: row.runtime?.version, aspnetCoreRuntimeVersion: row["aspnetcore-runtime"]?.version },
      }));
    }
    if (software.sourceType === "papermc") {
      const project = software.sourceConfig.project ?? "paper";
      const response = await axios.get("https://api.papermc.io/v2/projects/" + encodeURIComponent(project) + "/versions", { timeout: 20000, headers: { Accept: "application/json" } });
      const rows = (response.data as any).versions;
      if (!Array.isArray(rows)) throw new BadRequestException("PaperMC release source returned an invalid response");
      return rows.map((version: string) => ({ version, sourceUrl: "https://papermc.io/downloads/" + project, metadata: { project } }));
    }
    if (software.sourceType === "purpur") {
      const response = await axios.get("https://api.purpurmc.org/v2/purpur", { timeout: 20000, headers: { Accept: "application/json" } });
      const rows = (response.data as any).versions;
      if (!Array.isArray(rows)) throw new BadRequestException("Purpur release source returned an invalid response");
      return rows.map((version: string) => ({ version, sourceUrl: "https://purpurmc.org/downloads", metadata: { project: "purpur" } }));
    }
    if (software.sourceType === "fabric-meta") {
      const [games, loaders] = await Promise.all([
        axios.get("https://meta.fabricmc.net/v2/versions/game", { timeout: 20000, headers: { Accept: "application/json" } }),
        axios.get("https://meta.fabricmc.net/v2/versions/loader", { timeout: 20000, headers: { Accept: "application/json" } }),
      ]);
      if (!Array.isArray(games.data) || !Array.isArray(loaders.data)) throw new BadRequestException("Fabric metadata source returned an invalid response");
      const stableLoader = loaders.data.find((item: any) => item.stable === true);
      return games.data.map((row: any) => ({ version: String(row.version), prerelease: row.stable !== true, sourceUrl: "https://fabricmc.net/use/server/", metadata: { stable: row.stable === true, latestStableLoader: stableLoader?.version ?? null } }));
    }
    if (software.sourceType === "quilt-meta") {
      const response = await axios.get("https://meta.quiltmc.org/v3/versions/game", { timeout: 20000, headers: { Accept: "application/json" } });
      if (!Array.isArray(response.data)) throw new BadRequestException("Quilt metadata source returned an invalid response");
      return response.data.map((row: any) => ({ version: String(row.version), prerelease: row.stable !== true, sourceUrl: "https://quiltmc.org/en/install/server/", metadata: { stable: row.stable === true } }));
    }
    if (software.sourceType === "java-adoptium") {
      const info = await axios.get("https://api.adoptium.net/v3/info/available_releases", { timeout: 20000, headers: { Accept: "application/json" } });
      const majors = (info.data as any).available_lts_releases;
      if (!Array.isArray(majors)) throw new BadRequestException("Adoptium release source returned an invalid response");
      const assets = await Promise.all(majors.map((major: number) => axios.get("https://api.adoptium.net/v3/assets/latest/" + major + "/hotspot?architecture=x64&image_type=jdk&os=linux", { timeout: 20000, headers: { Accept: "application/json" } }).then(response => ({ major, data: response.data })).catch(() => ({ major, data: [] }))));
      return assets.flatMap(({ major, data }: any) => {
        const asset = Array.isArray(data) ? data[0] : undefined;
        const version = asset?.version?.semver;
        if (typeof version !== "string") return [];
        return [{ version, sourceUrl: "https://adoptium.net/temurin/releases/", architectures: ["x64"], operatingSystems: ["linux"], checksum: String(asset.binary?.package?.checksum ?? ""), metadata: { major, build: asset.version.build, architecture: "x64", os: "linux", imageType: "jdk", checksum: asset.binary?.package?.checksum } }];
      });
    }
    if (software.sourceType === "forge-maven" || software.sourceType === "neoforge-maven") {
      const metadataUrl = software.sourceType === "forge-maven"
        ? "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml"
        : "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
      const response = await axios.get(metadataUrl, { timeout: 20000, headers: { Accept: "application/xml,text/xml" }, responseType: "text" });
      if (typeof response.data !== "string" || !response.data.includes("<metadata")) throw new BadRequestException("Minecraft loader Maven metadata is invalid");
      const versions = [...response.data.matchAll(/<version>\s*([^<]+?)\s*<\/version>/g)].map(match => match[1].trim()).filter(Boolean);
      return [...new Set(versions)].map(version => ({ version, sourceUrl: metadataUrl, metadata: { loader: software.sourceType === "forge-maven" ? "forge" : "neoforge" } }));
    }
    if (software.sourceType === "python-releases") {
      const response = await axios.get("https://peps.python.org/api/python-releases.json", { timeout: 20000, headers: { Accept: "application/json" } });
      const cycles = (response.data as any)?.releases;
      if (!cycles || typeof cycles !== "object" || Array.isArray(cycles)) throw new BadRequestException("Python official release metadata returned an invalid response");
      const releases: DiscoveredVersion[] = [];
      for (const cycle of Object.values(cycles) as any[]) {
        if (!Array.isArray(cycle)) continue;
        for (const item of cycle) {
          if (item?.state !== "actual" || typeof item.stage !== "string") continue;
          const match = item.stage.match(/(\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?)/i);
          if (!match) continue;
          const version = match[1];
          releases.push({ version, releaseDate: item.date, prerelease: /(?:a|b|rc)\d+$/i.test(version),
            sourceUrl: "https://www.python.org/downloads/release/python" + version.replace(/\./g, ""),
            metadata: { releaseStage: item.stage, state: item.state, note: item.note ?? "", source: "Python PEP release metadata" } });
        }
      }
      return releases;
    }
    if (software.sourceType === "php-releases") {
      const majorVersion = software.sourceConfig.majorVersion ?? "";
      if (majorVersion && !/^\d{1,2}(?:\.\d{1,2})?$/.test(majorVersion)) throw new BadRequestException("PHP major version must be a number such as 8");
      const url = "https://www.php.net/releases/index.php?json&max=100" + (majorVersion ? "&version=" + encodeURIComponent(majorVersion) : "");
      const response = await axios.get(url, { timeout: 20000, headers: { Accept: "application/json" } });
      const rows = response.data;
      if (!rows || typeof rows !== "object" || Array.isArray(rows)) throw new BadRequestException("PHP official release metadata returned an invalid response");
      return Object.entries(rows).flatMap(([version, metadata]: [string, any]) => {
        if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) return [];
        const source = Array.isArray(metadata?.source) ? metadata.source : [];
        const archive = source.find((item: any) => typeof item?.filename === "string" && /\.tar\.(?:xz|gz|bz2)$/.test(item.filename));
        return [{ version, releaseDate: metadata?.date, sourceUrl: "https://www.php.net/releases/" + version + ".php",
          checksum: typeof archive?.sha256 === "string" ? archive.sha256 : "",
          metadata: { majorVersion: version.split(".")[0], sourceFiles: source.map((item: any) => ({ filename: item.filename, sha256: item.sha256 })) } }];
      });
    }
    if (software.sourceType === "lavalink-releases") {
      const results: DiscoveredVersion[] = [];
      for (let page = 1; page <= 5; page++) {
        const response = await axios.get("https://api.github.com/repos/lavalink-devs/Lavalink/releases?per_page=100&page=" + page, {
          timeout: 20000, headers: { Accept: "application/vnd.github+json", "User-Agent": "NIMBUS-Software-Manager" } });
        if (!Array.isArray(response.data)) throw new BadRequestException("Lavalink official release source returned an invalid response");
        const rows = response.data as any[];
        results.push(...rows.filter(item => !item.draft).map(item => ({
          version: String(item.tag_name ?? "").replace(/^v/, ""), releaseName: String(item.name ?? ""),
          releaseDate: item.published_at, prerelease: !!item.prerelease,
          sourceUrl: String(item.html_url ?? "https://github.com/lavalink-devs/Lavalink/releases"),
          sourceId: String(item.id ?? ""), metadata: { targetCommitish: item.target_commitish ?? "", javaRuntime: "Java 17 or newer" },
        })).filter(item => item.version));
        if (rows.length < 100) break;
      }
      return results;
    }
    if (software.sourceType === "mongodb-releases") {
      const response = await axios.get("https://downloads.mongodb.org/current.json", { timeout: 30000, headers: { Accept: "application/json" } });
      const rows = (response.data as any)?.versions;
      if (!Array.isArray(rows)) throw new BadRequestException("MongoDB official release manifest returned an invalid response");
      return rows.filter((row: any) => typeof row.version === "string" && row.development_release !== true && row.release_candidate !== true)
        .map((row: any) => {
          const supported = Array.isArray(row.downloads) ? row.downloads.filter((item: any) => item.edition === "targeted" && ["ubuntu2204", "ubuntu2404"].includes(String(item.target ?? ""))) : [];
          const architectures = [...new Set<string>(supported.map((item: any) => String(item.arch ?? "")).filter(Boolean))];
          const archive = supported.find((item: any) => item.archive?.sha256);
          return {
            version: String(row.version), releaseDate: row.date ? new Date(row.date).toISOString() : undefined,
            prerelease: false, sourceUrl: "https://www.mongodb.com/docs/manual/release-notes/",
            architectures, operatingSystems: ["linux"], checksum: String(archive?.archive?.sha256 ?? ""),
            compatibility: [...new Set<string>(supported.map((item: any) => String(item.target ?? "")).filter(Boolean))],
            metadata: { stable: true, targets: [...new Set<string>(supported.map((item: any) => String(item.target ?? "")).filter(Boolean))], releaseNotes: row.changes ?? "" },
          };
        });
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
          architectures: Array.isArray(row.images) ? [...new Set<string>(row.images.map((image: any) => String(image.architecture ?? "")).filter(Boolean))] : [],
          operatingSystems: Array.isArray(row.images) ? [...new Set<string>(row.images.map((image: any) => String(image.os ?? "").toLowerCase()).filter(Boolean))] : [],
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
