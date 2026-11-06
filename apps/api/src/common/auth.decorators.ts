import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Role } from "@nimbus/shared";
import { isStaff } from "@nimbus/shared";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: Role;
  mustChangePassword?: boolean;
}

export const ROLES_KEY = "nimbus:roles";
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Shorthand for endpoints any staff member may use. */
export const StaffOnly = () => Roles("owner", "admin", "staff");

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

export const isStaffRole = isStaff;
