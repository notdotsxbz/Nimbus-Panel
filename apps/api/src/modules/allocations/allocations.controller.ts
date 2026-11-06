import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { CurrentUser, Roles, type AuthUser } from "../../common/auth.decorators";
import { AllocationsService } from "./allocations.service";

@Controller("allocations")
export class AllocationsController {
  constructor(private readonly allocations: AllocationsService) {}

  @Get()
  @Roles("owner", "admin", "staff")
  list() {
    return this.allocations.list();
  }

  @Post("auto")
  @Roles("owner", "admin")
  auto(
    @Body() dto: { nodeId: string; ip: string; protocol: "tcp" | "udp" },
    @CurrentUser() actor: AuthUser,
  ) {
    return this.allocations.autoAllocate(dto.nodeId, dto.ip, dto.protocol, actor.id);
  }

  @Post()
  @Roles("owner", "admin")
  allocate(
    @Body() dto: { nodeId: string; ip: string; port: number; protocol: "tcp" | "udp" },
    @CurrentUser() actor: AuthUser,
  ) {
    return this.allocations.allocate(dto.nodeId, dto.ip, dto.port, dto.protocol, actor.id);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  release(@Param("id") id: string, @CurrentUser() actor: AuthUser) {
    return this.allocations.release(id, actor.id);
  }
}
