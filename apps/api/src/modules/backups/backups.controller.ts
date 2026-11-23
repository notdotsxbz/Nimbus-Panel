import { Body, Controller, Delete, Get, Param, Post, Put, Query, StreamableFile } from "@nestjs/common";
import { CurrentUser, Roles, type AuthUser } from "../../common/auth.decorators";
import { BackupsService } from "./backups.service";

@Controller("backups")
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query("serviceId") serviceId?: string) {
    return this.backups.list(user, serviceId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: { serviceId: string; trigger?: string; destination?: string },
  ) {
    return this.backups.enqueueBackupJob([dto.serviceId], user, dto.trigger ?? "manual", dto.destination ?? "gdrive");
  }

  @Get("drive-summary")
  driveSummary(@CurrentUser() user: AuthUser) {
    return this.backups.driveSummary(user);
  }

  @Get("jobs")
  listJobs(@CurrentUser() user: AuthUser) {
    return this.backups.listJobs(user);
  }

  @Get("jobs/:id")
  getJob(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.backups.getJob(id, user);
  }

  @Get("admin/summary")
  @Roles("owner", "admin")
  adminBackupSummary(@CurrentUser() user: AuthUser) {
    return this.backups.adminBackupSummary(user);
  }

  @Post("admin/restore-selection")
  @Roles("owner", "admin")
  restoreAdminSelection(
    @Body() dto: { mode: "selected-services" | "selected-customer"; backupIds?: string[]; customerId?: string; confirm?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    return this.backups.restoreAdminSelection(dto, user);
  }

  @Post("admin/full")
  @Roles("owner", "admin")
  createFullPanelBackup(@CurrentUser() user: AuthUser) {
    return this.backups.createFullPanelBackup(user);
  }

  @Post("admin/batch")
  @Roles("owner", "admin")
  createAdminBatch(
    @Body() dto: { mode: "all-customers" | "selected-customers" | "selected-services"; customerIds?: string[]; serviceIds?: string[] },
    @CurrentUser() user: AuthUser,
  ) {
    return this.backups.createAdminBatch(dto, user);
  }

  @Post("admin/full/:id/prepare-restore")
  @Roles("owner", "admin")
  prepareFullPanelRestore(
    @Param("id") id: string,
    @Body() dto: { confirm?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    return this.backups.prepareFullPanelRestore(id, user, dto.confirm === true);
  }

  @Get("schedule")
  getSchedule(@Query("serviceId") serviceId: string, @CurrentUser() user: AuthUser) {
    return this.backups.getSchedule(serviceId, user);
  }

  @Put("schedule")
  saveSchedule(
    @Body() dto: { serviceId: string; enabled?: boolean; frequency?: string; time?: string; retention?: number; notifyOnCompletion?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    return this.backups.saveSchedule(dto, user);
  }

  @Get(":id/download")
  async download(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    const file = await this.backups.download(id, user);
    return new StreamableFile(file.stream, {
      type: "application/octet-stream",
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  @Delete(":id")
  delete(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.backups.delete(id, user);
  }

  @Post(":id/restore")
  restore(@Param("id") id: string, @Body() dto: { confirm?: boolean }, @CurrentUser() user: AuthUser) {
    return this.backups.enqueueRestoreJob([id], user, dto.confirm === true);
  }


}
