import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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

  /** Edit node metadata/capacity. */
  @Patch(":id")
  @Roles("owner", "admin")
  update(
    @Param("id") id: string,
    @Body() dto: Parameters<NodesService["updateNode"]>[1],
    @CurrentUser() actor: AuthUser,
  ) {
    return this.nodes.updateNode(id, dto, actor.id);
  }

  /** Cached heartbeat + staleness; marks the node offline when stale. */
  @Post(":id/refresh-health")
  @Roles("owner", "admin", "staff")
  refreshHealth(@Param("id") id: string) {
    return this.nodes.refreshHealth(id);
  }

  @Get(":id/workloads")
  @Roles("owner", "admin", "staff")
  workloads(@Param("id") id: string) {
    return this.nodes.workloads(id);
  }

  @Get(":id/allocations")
  @Roles("owner", "admin", "staff")
  allocations(@Param("id") id: string) {
    return this.nodes.listAllocations(id);
  }

  /** Revoke the agent credential; node returns to enrolling with a new token. */
  @Post(":id/revoke-credentials")
  @Roles("owner", "admin")
  revokeCredentials(@Param("id") id: string, @CurrentUser() actor: AuthUser) {
    return this.nodes.revokeCredentials(id, actor.id);
  }

  /**
   * Delete Node — mode: "safe" (empty nodes only) or "force"
   * (owner-only, re-authentication + exact node name).
   */
  @Delete(":id")
  @Roles("owner", "admin")
  remove(
    @Param("id") id: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: { mode?: "safe" | "force"; confirmName?: string; password?: string },
  ) {
    return this.nodes.removeNode(id, dto.mode === "force" ? "force" : "safe", actor, dto.confirmName, dto.password);
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
