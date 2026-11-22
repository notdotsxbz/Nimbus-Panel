import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { CurrentUser, Roles, type AuthUser } from "../../common/auth.decorators";
import { SoftwareService } from "./software.service";

@Controller("software")
export class SoftwareController {
  constructor(private readonly software: SoftwareService) {}

  @Get()
  @Roles("owner", "admin")
  list() { return this.software.list(); }

  @Post()
  @Roles("owner", "admin")
  create(@Body() body: Record<string, unknown>, @CurrentUser() actor: AuthUser) {
    return this.software.create(body as never, actor);
  }

  @Patch(":id")
  @Roles("owner", "admin")
  update(@Param("id") id: string, @Body() body: Record<string, unknown>, @CurrentUser() actor: AuthUser) {
    return this.software.update(id, body as never, actor);
  }

  @Post("services/:serviceId/change")
  changeServiceSoftware(@Param("serviceId") serviceId: string, @Body() body: { softwareId: string; versionId: string }, @CurrentUser() actor: AuthUser) {
    return this.software.changeServiceSoftware(serviceId, body.softwareId, body.versionId, actor);
  }

  @Get("services/:serviceId/operations")
  operations(@Param("serviceId") serviceId: string, @CurrentUser() actor: AuthUser) {
    return this.software.listServiceOperations(serviceId, actor);
  }

  @Get(":id/versions")
  @Roles("owner", "admin")
  versions(@Param("id") id: string) { return this.software.listVersions(id); }

  @Post(":id/versions")
  @Roles("owner", "admin")
  addVersion(@Param("id") id: string, @Body() body: Record<string, unknown>, @CurrentUser() actor: AuthUser) {
    return this.software.addVersion(id, body as never, actor);
  }

  @Post(":id/fetch")
  @Roles("owner", "admin")
  discover(@Param("id") id: string, @CurrentUser() actor: AuthUser) {
    return this.software.discover(id, actor);
  }

  @Post(":id/versions/bulk")
  @Roles("owner", "admin")
  bulkVersions(@Param("id") id: string, @Body() body: { versionIds: string[]; action: string }, @CurrentUser() actor: AuthUser) {
    return this.software.bulkUpdateVersions(id, body.versionIds, body.action, actor);
  }

  @Post(":id/versions/bulk")
  @Roles("owner", "admin")
  bulkVersions(@Param("id") id: string, @Body() body: { versionIds: string[]; action: string }, @CurrentUser() actor: AuthUser) {
    return this.software.bulkUpdateVersions(id, body.versionIds, body.action, actor);
  }

  @Patch(":id/versions/:versionId")
  @Roles("owner", "admin")
  updateVersion(@Param("id") id: string, @Param("versionId") versionId: string, @Body() body: { publicationStatus?: string; deprecated?: boolean; recommended?: boolean }, @CurrentUser() actor: AuthUser) {
    return this.software.setVersion(id, versionId, body, actor);
  }

  @Get("for-service/:serviceId")
  customerOptions(@Param("serviceId") serviceId: string, @CurrentUser() actor: AuthUser) {
    return this.software.customerOptions(serviceId, actor);
  }
}
