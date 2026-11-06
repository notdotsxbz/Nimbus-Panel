import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { CurrentUser, type AuthUser } from "../../common/auth.decorators";
import { DomainsService } from "./domains.service";

@Controller("domains")
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.domains.listFor(user);
  }

  @Post("subdomain")
  createSubdomain(
    @CurrentUser() user: AuthUser,
    @Body() dto: { username: string; serviceType: string; serviceId: string },
  ) {
    return this.domains.createSubdomain(dto.username, dto.serviceType, dto.serviceId, user.id);
  }

  @Post("custom")
  addCustom(@CurrentUser() user: AuthUser, @Body() dto: { hostname: string }) {
    return this.domains.addCustomDomain(dto.hostname, user.id);
  }

  @Post(":id/verify")
  verify(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.domains.verify(id, user);
  }

  @Post(":id/map")
  map(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() dto: { serviceId: string }) {
    return this.domains.mapToService(id, dto.serviceId, user);
  }

  @Delete(":id")
  remove(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.domains.remove(id, user);
  }
}
