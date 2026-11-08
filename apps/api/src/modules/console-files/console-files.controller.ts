import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { CurrentUser, type AuthUser } from "../../common/auth.decorators";
import { AuditService } from "../audit/audit.service";
import { NodesService } from "../nodes/nodes.service";
import { ServicesService } from "../services/services.service";

/**
 * Universal console + file manager proxy. Every operation is:
 *  - ownership-checked server-side (customers touch only their own services)
 *  - relayed to the node agent over the authenticated agent API
 *  - audited when destructive
 * The panel never exposes agent credentials to the browser.
 */
@Controller()
export class ConsoleFilesController {
  constructor(
    private readonly services: ServicesService,
    private readonly nodes: NodesService,
    private readonly audit: AuditService,
  ) {}

  private async agentTarget(id: string, user: AuthUser) {
    const service = await this.services.get(id, user); // ownership enforced here
    const node = await this.nodes.get((service.nodeId as { _id: unknown }).toString());
    return { service, node };
  }

  // ── Console ──────────────────────────────────────────────────────

  @Get("services/:id/console/logs")
  async logs(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Query("tail") tail = "300",
  ) {
    const { service, node } = await this.agentTarget(id, user);
    const safeTail = Math.min(Math.max(parseInt(tail, 10) || 300, 1), 2000);
    const out = await this.nodes.agentCall(node, `/logs/${service._id}?tail=${safeTail}`, undefined, "GET");
    return out;
  }

  @Post("services/:id/console/exec")
  async exec(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: { command?: string },
  ) {
    if (!dto.command || dto.command.length > 500) {
      throw new BadRequestException("Command must be 1–500 characters");
    }
    const { service, node } = await this.agentTarget(id, user);
    const minecraft = service.type === "minecraft";
    const out = await this.nodes.agentCall(node, `/exec/${service._id}`, {
      command: dto.command,
      minecraft,
    });
    await this.audit.log({
      actorId: user.id,
      action: "console.exec",
      targetId: id,
      detail: dto.command.slice(0, 120),
    });
    return out;
  }

  // ── File manager ─────────────────────────────────────────────────

  @Get("services/:id/files")
  async list(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Query("path") path = "/",
  ) {
    const { service, node } = await this.agentTarget(id, user);
    return this.nodes.agentCall(node, `/files/${service._id}/list?path=${encodeURIComponent(path)}`, undefined, "GET");
  }

  @Get("services/:id/files/content")
  async read(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Query("path") path: string,
  ) {
    const { service, node } = await this.agentTarget(id, user);
    return this.nodes.agentCall(node, `/files/${service._id}/read?path=${encodeURIComponent(path)}`, undefined, "GET");
  }

  @Post("services/:id/files/write")
  async write(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: { path?: string; content?: string },
  ) {
    const { service, node } = await this.agentTarget(id, user);
    const out = await this.nodes.agentCall(node, `/files/${service._id}/write?path=${encodeURIComponent(dto.path ?? "/")}`, { content: dto.content ?? "" });
    await this.audit.log({ actorId: user.id, action: "files.write", targetId: id, detail: dto.path });
    return out;
  }

  @Post("services/:id/files/mkdir")
  async mkdir(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: { path?: string },
  ) {
    const { service, node } = await this.agentTarget(id, user);
    return this.nodes.agentCall(node, `/files/${service._id}/mkdir?path=${encodeURIComponent(dto.path ?? "/")}`, {});
  }

  @Post("services/:id/files/delete")
  async remove(
    @Req() _req: Request,
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: { path?: string },
  ) {
    const { service, node } = await this.agentTarget(id, user);
    const out = await this.nodes.agentCall(node, `/files/${service._id}/delete?path=${encodeURIComponent(dto.path ?? "/")}`, {});
    await this.audit.log({ actorId: user.id, action: "files.delete", targetId: id, detail: dto.path, sensitive: true });
    return out;
  }

  @Post("services/:id/files/rename")
  async rename(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: { path?: string; to?: string },
  ) {
    const { service, node } = await this.agentTarget(id, user);
    return this.nodes.agentCall(node, `/files/${service._id}/rename?path=${encodeURIComponent(dto.path ?? "/")}`, { to: dto.to });
  }
}
