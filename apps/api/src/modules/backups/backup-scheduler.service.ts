import { Injectable, OnModuleDestroy, OnModuleInit, BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import type { AuthUser } from "../../common/auth.decorators";
import { User, type UserDocument } from "../users/user.schema";
import { ServicesService } from "../services/services.service";
import { BackupsService } from "./backups.service";
import { BackupSchedule, type BackupScheduleDocument } from "./backup-schedule.schema";
import { NotificationsService } from "../notifications/notifications.service";
import { AuditService } from "../audit/audit.service";
import { IntegrationsService } from "../integrations/integrations.service";

type Frequency = "every6h" | "every12h" | "daily" | "weekly";
type RetentionMode = "count" | "days" | "never";

@Injectable()
export class BackupSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(
    @InjectModel(BackupSchedule.name) private readonly schedules: Model<BackupScheduleDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly services: ServicesService,
    private readonly backups: BackupsService,
    private readonly notifications: NotificationsService,
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    // Re-queue a schedule that was interrupted while its last run was active.
    await this.schedules.updateMany(
      { lastStatus: "running" },
      { $set: { nextRunAt: new Date(), lastError: "Previous scheduled run was interrupted by an API restart." } },
    );
    this.timer = setInterval(() => { void this.processDueSchedule(); }, 60_000);
    void this.processDueSchedule();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private assertCustomer(user: AuthUser) {
    if (user.role !== "customer") throw new ForbiddenException("Automatic service backup schedules are managed by each customer");
  }

  private nextRun(frequency: Frequency, backupTime: string, from: Date): Date {
    if (frequency === "every6h") return new Date(from.getTime() + 6 * 60 * 60 * 1000);
    if (frequency === "every12h") return new Date(from.getTime() + 12 * 60 * 60 * 1000);
    const [hours, minutes] = backupTime.split(":").map(Number);
    const next = new Date(from);
    next.setUTCHours(hours, minutes, 0, 0);
    if (next <= from) next.setUTCDate(next.getUTCDate() + (frequency === "weekly" ? 7 : 1));
    return next;
  }

  async list(user: AuthUser) {
    this.assertCustomer(user);
    return this.schedules.find({ ownerId: new Types.ObjectId(user.id) }).sort({ createdAt: -1 });
  }

  async upsert(user: AuthUser, dto: {
    serviceId: string;
    enabled?: boolean;
    frequency: Frequency;
    backupTime?: string;
    retentionMode?: RetentionMode;
    retentionCount?: 5 | 10 | 30;
    retentionDays?: number;
    notifyOnCompletion?: boolean;
  }) {
    this.assertCustomer(user);
    if (!/^[a-f0-9]{24}$/i.test(dto.serviceId)) throw new BadRequestException("Invalid service id");
    if (!["every6h", "every12h", "daily", "weekly"].includes(dto.frequency)) throw new BadRequestException("Invalid backup frequency");
    const backupTime = dto.backupTime ?? "02:00";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backupTime)) throw new BadRequestException("Backup time must use HH:mm in UTC");
    const retentionMode = dto.retentionMode ?? "count";
    if (!["count", "days", "never"].includes(retentionMode)) throw new BadRequestException("Invalid retention mode");
    const retentionCount = dto.retentionCount ?? 5;
    if (retentionMode === "count" && ![5, 10, 30].includes(retentionCount)) throw new BadRequestException("Retention count must be 5, 10 or 30");
    if (retentionMode === "days" && (!dto.retentionDays || dto.retentionDays < 1 || dto.retentionDays > 365)) {
      throw new BadRequestException("Retention days must be between 1 and 365");
    }
    await this.services.get(dto.serviceId, user);
    if (dto.enabled !== false) await this.integrations.googleDriveAccessToken(user);
    const nextRunAt = this.nextRun(dto.frequency, backupTime, new Date());
    const schedule = await this.schedules.findOneAndUpdate(
      { serviceId: new Types.ObjectId(dto.serviceId), ownerId: new Types.ObjectId(user.id) },
      {
        $set: {
          enabled: dto.enabled ?? true,
          frequency: dto.frequency,
          backupTime,
          timezone: "UTC",
          retentionMode,
          retentionCount,
          retentionDays: retentionMode === "days" ? dto.retentionDays : undefined,
          notifyOnCompletion: dto.notifyOnCompletion ?? true,
          nextRunAt,
          lastError: undefined,
        },
        $setOnInsert: { ownerId: new Types.ObjectId(user.id), serviceId: new Types.ObjectId(dto.serviceId) },
      },
      { upsert: true, new: true, runValidators: true },
    );
    await this.audit.log({ actorId: user.id, action: "backups.schedule.upsert", targetType: "service", targetId: dto.serviceId, sensitive: true });
    return schedule;
  }

  async remove(user: AuthUser, serviceId: string) {
    this.assertCustomer(user);
    if (!/^[a-f0-9]{24}$/i.test(serviceId)) throw new BadRequestException("Invalid service id");
    await this.services.get(serviceId, user);
    const result = await this.schedules.deleteOne({
      serviceId: new Types.ObjectId(serviceId),
      ownerId: new Types.ObjectId(user.id),
    });
    if (!result.deletedCount) throw new NotFoundException("Backup schedule not found");
    await this.audit.log({ actorId: user.id, action: "backups.schedule.delete", targetType: "service", targetId: serviceId, sensitive: true });
    return { deleted: true };
  }

  private async processDueSchedule() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = new Date();
      const candidate = await this.schedules.findOne({ enabled: true, nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 });
      if (!candidate) return;
      const nextRunAt = this.nextRun(candidate.frequency, candidate.backupTime, now);
      const claimed = await this.schedules.findOneAndUpdate(
        { _id: candidate._id, enabled: true, nextRunAt: candidate.nextRunAt },
        { $set: { nextRunAt, lastRunAt: now, lastStatus: "running", lastError: undefined } },
        { new: true },
      );
      if (!claimed) return;

      const account = await this.users.findById(claimed.ownerId).select("role suspended deletedAt");
      if (!account || account.role !== "customer" || account.suspended || account.deletedAt) {
        claimed.enabled = false;
        claimed.lastStatus = "failed";
        claimed.lastError = "Customer account is unavailable; automatic backups disabled.";
        await claimed.save();
        return;
      }
      const actor = { id: claimed.ownerId.toString(), role: account.role } as AuthUser;
      let status: "completed" | "failed" = "failed";
      let errorMessage = "";
      try {
        const backup = await this.backups.create(claimed.serviceId.toString(), actor, "scheduled", "gdrive");
        status = backup.status === "completed" ? "completed" : "failed";
        errorMessage = backup.error ?? "";
        if (status === "completed") await this.applyRetention(claimed, actor);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : "Scheduled backup failed";
      }
      claimed.lastStatus = status;
      claimed.lastError = errorMessage || undefined;
      await claimed.save();
      if (claimed.notifyOnCompletion) {
        await this.notifications.notify(
          claimed.ownerId.toString(),
          "backup",
          status === "completed" ? "Scheduled backup completed" : "Scheduled backup failed",
          status === "completed" ? "Your scheduled service backup was uploaded to your Google Drive." : (errorMessage || "Your scheduled service backup could not be completed."),
        ).catch(() => undefined);
      }
    } catch {
      // Keep the scheduler alive; an individual schedule failure must not stop later runs.
    } finally {
      this.busy = false;
    }
  }

  private async applyRetention(schedule: BackupScheduleDocument, user: AuthUser) {
    if (schedule.retentionMode === "never") return;
    const rows = await this.backups.list(user, schedule.serviceId.toString());
    const sorted = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const expired = schedule.retentionMode === "count"
      ? sorted.slice(schedule.retentionCount)
      : sorted.filter(row => new Date(row.createdAt).getTime() < Date.now() - (schedule.retentionDays ?? 30) * 24 * 60 * 60 * 1000);
    for (const backup of expired) {
      await this.backups.delete(backup._id!.toString(), user).catch(() => undefined);
    }
  }
}
