import { Body, Controller, Delete, Get, Param, Post, Query, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { Res } from "@nestjs/common";
import { CurrentUser, Roles, type AuthUser } from "../../common/auth.decorators";
import { BackupsService } from "./backups.service";
import { PanelBackupsService } from "./panel-backups.service";
import { BackupSchedulerService } from "./backup-scheduler.service";

@Controller("backups")
export class BackupsController {
  constructor(private readonly backups: BackupsService, private readonly panelBackups: PanelBackupsService, private readonly scheduler: BackupSchedulerService) {}

  @Get("drive-folder")
  getDriveFolderUrl(@CurrentUser() user: AuthUser) {
    return this.backups.getDriveFolderUrl(user);
  }

  @Get("schedules")
  @Roles("customer")
  listSchedules(@CurrentUser() user: AuthUser) {
    return this.scheduler.list(user);
  }

  @Post("schedules")
  @Roles("customer")
  upsertSchedule(
    @CurrentUser() user: AuthUser,
    @Body() dto: {
      serviceId: string;
      enabled?: boolean;
      frequency: "every6h" | "every12h" | "daily" | "weekly";
      backupTime?: string;
      retentionMode?: "count" | "days" | "never";
      retentionCount?: 5 | 10 | 30;
      retentionDays?: number;
      notifyOnCompletion?: boolean;
    },
  ) {
    return this.scheduler.upsert(user, dto);
  }

  @Delete("schedules/:serviceId")
  @Roles("customer")
  removeSchedule(@Param("serviceId") serviceId: string, @CurrentUser() user: AuthUser) {
    return this.scheduler.remove(user, serviceId);
  }

  @Get("admin/full/schedule")
  @Roles("owner", "admin")
  getFullBackupSchedule(@CurrentUser() user: AuthUser) {
    return this.panelBackups.getFullBackupSchedule(user);
  }

  @Post("admin/full/schedule")
  @Roles("owner", "admin")
  upsertFullBackupSchedule(
    @CurrentUser() user: AuthUser,
    @Body() dto: { enabled?: boolean; frequency: "daily" | "weekly"; backupTime?: string },
  ) {
    return this.panelBackups.upsertFullBackupSchedule(user, dto);
  }

  @Delete("admin/full/schedule")
  @Roles("owner", "admin")
  removeFullBackupSchedule(@CurrentUser() user: AuthUser) {
    return this.panelBackups.removeFullBackupSchedule(user);
  }

  @Post("admin/selected")
  @Roles("owner", "admin")
  createSelectedBackups(
    @CurrentUser() user: AuthUser,
    @Body() dto: { customerIds?: string[]; serviceIds?: string[] },
  ) {
    return this.panelBackups.createSelectedBackup(user, dto);
  }

  @Get("admin/full")
  @Roles("owner", "admin")
  listFullPanelBackups(@CurrentUser() user: AuthUser) {
    return this.panelBackups.list(user);
  }

  @Get("admin/full/:id")
  @Roles("owner", "admin")
  getFullPanelBackup(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.panelBackups.get(id, user);
  }

  @Post("admin/full/:id/prepare-restore")
  @Roles("owner", "admin")
  prepareFullPanelRestore(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.panelBackups.prepareRestore(id, user);
  }

  @Post("admin/full")
  @Roles("owner", "admin")
  createFullPanelBackup(@CurrentUser() user: AuthUser) {
    return this.panelBackups.createFullPanelBackup(user);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query("serviceId") serviceId?: string) {
    return this.backups.list(user, serviceId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: { serviceId: string; trigger?: string; destination?: string },
  ) {
    return this.backups.create(dto.serviceId, user, dto.trigger ?? "manual", dto.destination ?? "gdrive");
  }

  @Get(":id/download")
  async download(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.backups.download(id, user);
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    if (file.sizeBytes !== undefined) response.setHeader("Content-Length", String(file.sizeBytes));
    return new StreamableFile(file.stream, {
      type: "application/octet-stream",
      disposition: `attachment; filename="${file.filename}"`,
      length: file.sizeBytes,
    });
  }

  @Delete(":id")
  delete(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.backups.delete(id, user);
  }

  @Post(":id/retry-upload")
  retryUpload(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.backups.retryUpload(id, user);
  }

  @Post(":id/restore")
  restore(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.backups.restore(id, user);
  }
}
