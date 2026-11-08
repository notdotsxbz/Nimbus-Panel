import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthUser } from "../../common/auth.decorators";
import { Roles } from "../../common/auth.decorators";
import { TicketsService } from "./tickets.service";

@Controller("tickets")
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  /** Any authenticated customer can create a support ticket. */
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: { subject?: string; body?: string; priority?: string },
  ) {
    return this.tickets.create(user.id, user.role, dto);
  }

  /** Customers get their own tickets; staff gets everything. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query("status") status?: string) {
    return this.tickets.listFor(user, status);
  }

  @Get("stats")
  @Roles("owner", "admin", "staff")
  stats() {
    return this.tickets.stats();
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.get(id, user);
  }

  @Post(":id/reply")
  reply(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() dto: { body?: string }) {
    return this.tickets.reply(id, user, dto.body);
  }

  /** Staff-only status changes (open / in_progress / waiting / closed). */
  @Post(":id/status")
  setStatus(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() dto: { status?: string }) {
    return this.tickets.setStatus(id, user, dto.status);
  }
}
