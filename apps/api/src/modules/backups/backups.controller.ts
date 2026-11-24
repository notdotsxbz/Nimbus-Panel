import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthUser } from "../../common/auth.decorators";
import { BackupsService } from "./backups.service";
import { IntegrationsService } from "../integrations/integrations.service";

@Controller("backups")
export class BackupsController {
  constructor(private readonly backups: BackupsService, private readonly integrations: IntegrationsService) {}

  @Get("google-drive")
  customerDriveStatus(@CurrentUser() user: AuthUser) {
    return this.integrations.customerGoogleDriveStatus(user.id);
  }

  @Post("google-drive/connect")
  customerDriveConnect(@CurrentUser() user: AuthUser) {
    return this.integrations.beginCustomerGoogleDriveConnect(user.id);
  }

  @Post("google-drive/exchange")
  customerDriveExchange(@CurrentUser() user: AuthUser, @Body() dto: { code: string; state: string }) {
    return this.integrations.exchangeCustomerGoogleDriveCode(user.id, dto.code, dto.state);
  }

  @Delete("google-drive")
  customerDriveDisconnect(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectCustomerGoogleDrive(user.id);
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

  @Post("selected")
  createSelected(@CurrentUser() user: AuthUser, @Body() dto: { serviceIds: string[]; destination?: string }) {
    return this.backups.createSelected(dto?.serviceIds, user, dto?.destination ?? "local");
  }

  @Post("selected/restore")
  restoreSelected(@CurrentUser() user: AuthUser, @Body() dto: { backupIds: string[]; confirm?: boolean }) {
    if (dto?.confirm !== true) throw new BadRequestException("Explicit restore confirmation is required");
    return this.backups.restoreSelected(dto.backupIds, user);
  }

  @Post(":id/restore")
  restore(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() dto: { confirm?: boolean }) {
    if (dto?.confirm !== true) throw new BadRequestException("Explicit restore confirmation is required");
    return this.backups.restore(id, user);
  }


}
