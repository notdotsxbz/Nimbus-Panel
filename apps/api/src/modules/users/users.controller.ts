import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, Roles, type AuthUser } from "../../common/auth.decorators";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @Roles("owner", "admin")
  create(@Body() dto: { email: string; username: string; password: string; role?: string; displayName?: string }) {
    return this.users.createCustomer(dto);
  }

  @Get()
  @Roles("owner", "admin", "staff")
  list(@Query("q") q?: string, @Query("page") page = "1") {
    const filter = q
      ? { $or: [{ email: new RegExp(q, "i") }, { username: new RegExp(q, "i") }] }
      : {};
    return this.users.list(filter, 25, (parseInt(page, 10) - 1) * 25);
  }

  @Get(":id")
  @Roles("owner", "admin", "staff")
  get(@Param("id") id: string) {
    return this.users.findById(id);
  }

  @Post(":id/password")
  @Roles("owner", "admin")
  async resetAuth(@Param("id") id: string, @Body() dto: { password: string }, @CurrentUser() actor: AuthUser) {
    const temp = dto.password ?? `nb-${Math.random().toString(36).slice(2, 14)}`;
    const user = await this.users.findById(id);
    if (!user) return null;
    await this.users.changePasswordForAdmin(id, temp, actor.id);
    return { temporaryPassword: temp };
  }

  @Patch(":id/suspended")
  @Roles("owner", "admin")
  setSuspended(@Param("id") id: string, @Body() dto: { suspended: boolean }, @CurrentUser() actor: AuthUser) {
    return this.users.setSuspended(id, dto.suspended, actor.id);
  }

  @Patch("me/username")
  changeUsername(@CurrentUser() actor: AuthUser, @Body() dto: { username: string }) {
    return this.users.changeUsername(actor.id, dto.username);
  }

  @Post("me/password")
  changePassword(@CurrentUser() actor: AuthUser, @Body() dto: { current: string; next: string }) {
    return this.users.changePassword(actor.id, dto.current, dto.next);
  }
}
