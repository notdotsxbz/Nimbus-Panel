import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/public.decorator";
import { Roles } from "../../common/auth.decorators";
import { CurrentUser, type AuthUser } from "../../common/auth.decorators";
import { NodesService } from "./nodes.service";

@Controller("nodes")
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Get()
  @Roles("owner", "admin", "staff")
  list() {
    return this.nodes.list();
  }

  @Get("capacity")
  @Roles("owner", "admin", "staff")
  capacity() {
    return this.nodes.findCapacity(0, 0);
  }

  @Post()
  @Roles("owner", "admin")
  create(@Body() dto: Parameters<NodesService["create"]>[0], @CurrentUser() actor: AuthUser) {
    return this.nodes.create(dto, actor.id);
  }

  @Post(":id/maintenance")
  @Roles("owner", "admin")
  maintenance(
    @Param("id") id: string,
    @Body() dto: { enabled: boolean },
    @CurrentUser() actor: AuthUser,
  ) {
    return this.nodes.setMaintenance(id, dto.enabled, actor.id);
  }

  // ── Agent-facing endpoints (authenticated with enrollment / node tokens) ──

  @Public()
  @Post("agent/enroll")
  async enroll(@Body() body: { nodeId: string; jti: string }) {
    const agentToken = await this.nodes.completeEnrollment(body.nodeId, body.jti);
    return { agentToken };
  }

  @Public()
  @Put("agent/heartbeat")
  async heartbeat(@Req() req: Request, @Body() hb: Record<string, number | string>) {
    const nodeId = req.headers["x-nimbus-node"] as string | undefined;
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!nodeId || !token) throw new UnauthorizedException("Missing agent credentials");
    const node = await this.nodes.authenticateAgent(nodeId, token);
    return this.nodes.heartbeat(node, hb as never);
  }
}
