import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CurrentUser, Roles, type AuthUser } from "../../common/auth.decorators";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query("limit") limit = "50") {
    return this.notifications.list(user.id, Math.min(parseInt(limit, 10) || 50, 100));
  }

  @Get("unread-count")
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.id).then((count) => ({ count }));
  }

  @Post(":id/read")
  markRead(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.notifications.markRead(user.id, id);
  }

  @Post("read-all")
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  /** Owner/admin broadcast — appears on every active account's bell. */
  @Post("broadcast")
  @Roles("owner", "admin")
  broadcast(@CurrentUser() actor: AuthUser, @Body() dto: { title?: string; body?: string; type?: string }) {
    return this.notifications.broadcast(actor.id, dto);
  }
}
