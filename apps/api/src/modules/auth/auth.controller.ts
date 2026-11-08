import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { env } from "../../config/env";
import { FirebaseAdminService } from "../../firebase/firebase-admin.service";
import { AuditService } from "../audit/audit.service";
import { UsersService } from "../users/users.service";
import { CurrentUser, type AuthUser } from "../../common/auth.decorators";
import { Public } from "../../common/public.decorator";
import { JWT_COOKIE } from "../../common/constants";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly firebase: FirebaseAdminService,
    private readonly audit: AuditService,
  ) {}

  /** ONE common login page — role routing happens server-side. */
  @Public()
  @Post("login")
  @HttpCode(200)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async login(
    @Body() body: { identifier?: string; email?: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const identifier = (body.identifier ?? body.email ?? "").toLowerCase().trim();
    const user = await this.users.verifyCredentials(identifier, body.password);
    if (!user) {
      await this.audit.log({ action: "auth.login.failed", detail: identifier, sensitive: true });
      throw new UnauthorizedException("Invalid credentials");
    }
    if (user.suspended) throw new UnauthorizedException("Account suspended");
    await this.users.recordLogin(user._id.toString(), true);
    const token = await this.signSession(user);
    this.setCookie(res, token);
    return {
      token,
      user: this.publicUser(user),
      redirect: this.routeForRole(user.role),
    };
  }

  /** Firebase ID token login (email/password, Google, passkeys …). */
  @Public()
  @Post("firebase")
  @HttpCode(200)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async firebaseLogin(
    @Body() body: { idToken: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const decoded = await this.firebase.verifyIdToken(body.idToken);
    let user = await this.users.findByFirebaseUid(decoded.uid);
    if (!user && decoded.email) user = await this.users.findByEmail(decoded.email);
    if (!user) {
      user = await this.users.createFirebaseUser(decoded.uid, decoded.email ?? decoded.uid, decoded.name);
    }
    if (user.suspended) throw new UnauthorizedException("Account suspended");
    await this.users.recordLogin(user._id.toString(), true);
    const token = await this.signSession(user);
    this.setCookie(res, token);
    return { token, user: this.publicUser(user), redirect: this.routeForRole(user.role) };
  }

  @Post("logout")
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(JWT_COOKIE, this.cookieOptions());
    return { ok: true };
  }

  @Get("me")
  async me(@CurrentUser() user: AuthUser) {
    const full = await this.users.findById(user.id);
    if (!full) throw new NotFoundException();
    return this.publicUser(full);
  }

  private async signSession(user: { _id: unknown; email: string; username: string; role: string; mustChangePassword?: boolean; tokenVersion?: number }) {
    return this.jwt.signAsync({
      sub: user._id!.toString(),
      email: user.email,
      username: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword ?? false,
      tokenVersion: user.tokenVersion ?? 0,
    });
  }

  private routeForRole(role: string): string {
    return role === "customer" ? "/dashboard" : "/admin";
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: env.nodeEnv === "production",
      sameSite: "lax" as const,
      path: "/",
    };
  }

  private setCookie(res: Response, token: string) {
    res.cookie(JWT_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: 7 * 24 * 3600 * 1000,
    });
  }

  private publicUser(user: { _id: unknown; email: string; username: string; role: string; mustChangePassword?: boolean }) {
    return {
      id: user._id!.toString(),
      email: user.email,
      username: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword ?? false,
    };
  }
}
