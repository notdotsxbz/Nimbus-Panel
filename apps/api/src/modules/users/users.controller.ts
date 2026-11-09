import { randomBytes } from "node:crypto";
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, Roles, type AuthUser } from "../../common/auth.decorators";
import { UsersService } from "./users.service";
import { IntegrationsService } from "../integrations/integrations.service";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService, private readonly integrations: IntegrationsService) {}

  @Post()
  @Roles("owner")
  async create(@Body() dto: { email: string; username: string; password: string; role?: string; displayName?: string }) {
    const firebaseUser = await this.integrations.createFirebaseAuthUser(dto.email, dto.password, dto.displayName);
    try {
      return await this.users.createFirebaseCustomer({
        email: dto.email, username: dto.username, role: dto.role,
        displayName: dto.displayName, firebaseUid: firebaseUser.uid,
      });
    } catch (error) {
      await this.integrations.deleteFirebaseAuthUser(firebaseUser.uid);
      throw error;
    }
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
  @Roles("owner")
  async resetAuth(@Param("id") id: string, @CurrentUser() actor: AuthUser) {
    const temp = "Nb-" + randomBytes(18).toString("base64url");
    const user = await this.users.findById(id);
    if (!user) return null;
    if (user.firebaseUid) {
      await this.integrations.updateFirebaseAuthUserPassword(user.firebaseUid, temp);
    } else {
      const firebaseUser = await this.integrations.createFirebaseAuthUser(user.email, temp);
      await this.users.markFirebaseAccount(id, firebaseUser.uid, actor.id);
    }
    return { temporaryPassword: temp };
  }

  @Patch(":id/suspended")
  @Roles("owner", "admin")
  setSuspended(@Param("id") id: string, @Body() dto: { suspended: boolean }, @CurrentUser() actor: AuthUser) {
    return this.users.setSuspendedWithRevocation(id, dto.suspended, actor.id);
  }

  /** Role change: owner may grant/revoke any role; admins manage customer/staff. */
  @Patch(":id/role")
  @Roles("owner", "admin")
  changeRole(@Param("id") id: string, @Body() dto: { role: string }, @CurrentUser() actor: AuthUser) {
    return this.users.changeRole(id, dto.role, actor);
  }

  /** Soft deletion — audit and billing records preserved, sessions revoked. */
  @Delete(":id")
  @Roles("owner", "admin")
  async delete(@Param("id") id: string, @CurrentUser() actor: AuthUser) {
    const target = await this.users.findById(id);
    const result = await this.users.deleteUser(id, actor);
    if (target?.firebaseUid) await this.integrations.deleteFirebaseAuthUser(target.firebaseUid);
    return result;
  }

  @Patch("me/username")
  changeUsername(@CurrentUser() actor: AuthUser, @Body() dto: { username: string }) {
    return this.users.changeUsername(actor.id, dto.username);
  }

}
