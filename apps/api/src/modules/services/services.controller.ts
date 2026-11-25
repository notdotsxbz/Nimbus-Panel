import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { CurrentUser, Roles, type AuthUser } from "../../common/auth.decorators";
import { ServicesService } from "./services.service";

@Controller("services")
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.services.listFor(user);
  }

  @Get("stats")
  @Roles("owner", "admin", "staff")
  stats() {
    return this.services.stats();
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.services.get(id, user);
  }

  @Post()
  @Roles("owner", "admin")
  create(@Body() dto: Parameters<ServicesService["create"]>[0], @CurrentUser() actor: AuthUser) {
    return this.services.create(dto, actor);
  }

  @Patch(":id/owner")
  @Roles("owner")
  assignOwner(@Param("id") id: string, @Body() dto: { ownerId: string }, @CurrentUser() actor: AuthUser) {
    return this.services.assignOwner(id, dto.ownerId, actor);
  }

  @Patch(":id/expiry")
  @Roles("owner", "admin")
  setExpiry(@Param("id") id: string, @Body() dto: { days?: number | null }, @CurrentUser() actor: AuthUser) {
    return this.services.setExpiry(id, dto.days, actor);
  }

  @Post(":id/suspend")
  @Roles("owner", "admin")
  suspend(@Param("id") id: string, @CurrentUser() actor: AuthUser) {
    return this.services.suspend(id, actor);
  }

  @Post(":id/unsuspend")
  @Roles("owner", "admin")
  unsuspend(@Param("id") id: string, @CurrentUser() actor: AuthUser) {
    return this.services.unsuspend(id, actor);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  remove(@Param("id") id: string, @CurrentUser() actor: AuthUser) {
    return this.services.remove(id, actor);
  }

  /** start | stop | restart | reinstall */
  @Post(":id/power/:action")
  power(
    @Param("id") id: string,
    @Param("action") action: "start" | "stop" | "restart" | "reinstall",
    @CurrentUser() actor: AuthUser,
  ) {
    return this.services.power(id, action, actor);
  }
}
