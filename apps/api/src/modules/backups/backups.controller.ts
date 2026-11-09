import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthUser } from "../../common/auth.decorators";
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

  @Post(":id/restore")
  restore(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.backups.restore(id, user);
  }


}
