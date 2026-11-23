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
    return this.backups.create(dto.serviceId, user, dto.trigger ?? "manual", dto.destination ?? "gdrive");
  }

  @Get("admin/summary")
  @Roles("owner", "admin")
  adminBackupSummary(@CurrentUser() user: AuthUser) {
    return this.backups.adminBackupSummary(user);
  }

  @Post("admin/batch")
  @Roles("owner", "admin")
  createAdminBatch(
    @Body() dto: { mode: "all-customers" | "selected-customers" | "selected-services"; customerIds?: string[]; serviceIds?: string[] },
    @CurrentUser() user: AuthUser,
  ) {
    return this.backups.createAdminBatch(dto, user);
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
    return new StreamableFile(file.buffer, {
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
    return this.backups.restore(id, user, dto.confirm === true);
  }


}
