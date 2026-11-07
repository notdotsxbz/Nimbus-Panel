import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { env } from "../config/env";
import type { AuthUser } from "./auth.decorators";
import { ROLES_KEY } from "./auth.decorators";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { JWT_COOKIE } from "./constants";
import type { Role } from "@nimbus/shared";
import { isStaff } from "@nimbus/shared";

export interface RequestWithUser extends Request {
  user: AuthUser;
}

/** Verifies the session JWT from the httpOnly cookie or Authorization header. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const rawCookie = req.headers.cookie ?? "";
    const cookieMatch = rawCookie.match(new RegExp(`${JWT_COOKIE}=([^;]+)`));
    const token = bearer ?? (cookieMatch ? decodeURIComponent(cookieMatch[1]) : undefined);
    if (!token) throw new UnauthorizedException("Missing session token");

    try {
      const payload = await this.jwt.verifyAsync(token, { secret: env.jwtSecret });
      req.user = {
        id: payload.sub,
        email: payload.email,
        username: payload.username,
        role: payload.role,
        mustChangePassword: payload.mustChangePassword,
      };
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired session");
    }
  }
}

export const ROLE_CHECK_KEY = "nimbus:role-check";

/**
 * RBAC gate. Supports @Roles(...) lists and the owner-only sentinel.
 * Customers can only reach endpoints without role metadata.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (!user) return false;
    return required.some((r) =>
      r === ("staff" satisfies Role) ? isStaff(user.role) : user.role === r,
    );
  }
}

export const OwnerOnly = () => SetMetadata(ROLE_CHECK_KEY, "owner");
