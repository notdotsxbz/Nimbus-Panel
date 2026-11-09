import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import * as bcrypt from "bcryptjs";
import { env } from "../../config/env";
import { AuditService } from "../audit/audit.service";
import { User, UserDocument } from "./user.schema";

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

@Injectable()
export class UsersService implements OnModuleInit {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
  ) {}

  /** Seed the bootstrap administrator (credentials forced to change at first login). */
  async onModuleInit(): Promise<void> {
    const exists = await this.users.countDocuments({ role: { $in: ["owner", "admin"] } });
    if (exists > 0) return;
    const email = env.bootstrapAdminEmail.toLowerCase();
    await this.users.create({
      email,
      username: "admin",
      passwordHash: await bcrypt.hash(env.bootstrapAdminPassword, 12),
      role: "owner",
      mustChangePassword: true,
    });
    console.warn(
      `[bootstrap] Seeded owner account ${email} — the password MUST be changed on first login.`,
    );
  }

  async verifyCredentials(identifier: string, password: string): Promise<UserDocument | null> {
    if (!identifier || !password) return null;
    const user = await this.users
      .findOne({ $or: [{ email: identifier }, { username: identifier }], deletedAt: { $exists: false } })
      .select("+passwordHash +tokenVersion");
    if (!user?.passwordHash) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    return ok ? user : null;
  }

  /** One-time bootstrap: move the seeded owner into Firebase without exposing signup. */
  async verifyBootstrapOwner(email: string, password: string): Promise<UserDocument> {
    const user = await this.verifyCredentials(email.toLowerCase().trim(), password);
    if (!user || user.role !== "owner" || user.firebaseUid || user.deletedAt || user.suspended) {
      throw new ForbiddenException("Owner bootstrap is not available for this account");
    }
    return user;
  }

  async linkFirebaseUid(user: UserDocument, uid: string) {
    user.firebaseUid = uid;
    user.passwordHash = undefined;
    user.mustChangePassword = false;
    await user.save();
    await this.audit.log({ actorId: user._id!.toString(), action: "auth.firebase.ownerBootstrap", sensitive: true });
  }

  /** Current tokenVersion for session-revocation checks (banned/bumped users). */
  async getTokenVersion(userId: string): Promise<number> {
    const user = await this.users.findById(userId).select("+tokenVersion deletedAt suspended");
    if (!user || user.deletedAt) return -1; // deleted accounts fail all sessions
    return user.tokenVersion ?? 0;
  }

  async findByEmail(email: string) {
    return this.users.findOne({ email: email.toLowerCase() });
  }

  async findByFirebaseUid(uid: string) {
    return this.users.findOne({ firebaseUid: uid });
  }

  async findById(id: string) {
    return this.users.findById(id);
  }

  async createFirebaseUser(uid: string, email: string, displayName?: string) {
    const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "") || "user";
    const username = await this.availableUsername(base);
    return this.users.create({
      email: email.toLowerCase(),
      username,
      firebaseUid: uid,
      displayName,
      role: "customer",
    });
  }

  /** Owner-created Firebase account; passwords are managed only by Firebase Auth. */
  async createFirebaseCustomer(dto: { email: string; username: string; firebaseUid: string; role?: string; displayName?: string }) {
    const email = dto.email.toLowerCase().trim();
    const username = dto.username.toLowerCase().trim();
    if (!USERNAME_RE.test(username)) throw new BadRequestException("Invalid username");
    if (!["customer", "staff", "admin"].includes(dto.role ?? "customer")) throw new BadRequestException("Invalid role");
    if (await this.users.findOne({ $or: [{ email }, { username }] })) throw new ConflictException("Email or username already taken");
    const user = await this.users.create({
      email, username, firebaseUid: dto.firebaseUid,
      role: (dto.role as UserDocument["role"]) ?? "customer",
      displayName: dto.displayName,
    });
    await this.audit.log({ action: "users.create", targetType: "user", targetId: user._id!.toString(), sensitive: true, detail: "Firebase Authentication account" });
    return user;
  }

  /** Admin creates a customer with local credentials. */
  async createCustomer(dto: {
    email: string;
    username: string;
    password: string;
    role?: string;
    displayName?: string;
  }) {
    const email = dto.email.toLowerCase().trim();
    const username = dto.username.toLowerCase().trim();
    if (!USERNAME_RE.test(username)) {
      throw new BadRequestException(
        "Username must be 3–32 chars: lowercase letters, digits, . _ - and start alphanumeric",
      );
    }
    if (await this.users.findOne({ $or: [{ email }, { username }] })) {
      throw new ConflictException("Email or username already taken");
    }
    if (dto.password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters");
    }
    const user = await this.users.create({
      email,
      username,
      passwordHash: await bcrypt.hash(dto.password, 12),
      role: (dto.role as UserDocument["role"]) ?? "customer",
      displayName: dto.displayName,
    });
    await this.audit.log({
      action: "users.create",
      targetType: "user",
      targetId: user._id!.toString(),
      sensitive: true,
    });
    return user;
  }

  /** Safe username changes — uniqueness checked case-insensitively. */
  async changeUsername(userId: string, username: string) {
    const clean = username.toLowerCase().trim();
    if (!USERNAME_RE.test(clean)) throw new BadRequestException("Invalid username");
    const clash = await this.users.findOne({ username: clean, _id: { $ne: userId } });
    if (clash) throw new ConflictException("Username already taken");
    return this.users.findByIdAndUpdate(userId, { username: clean }, { new: true });
  }

  async changePassword(userId: string, current: string, next: string) {
    if (next.length < 8) throw new BadRequestException("Password must be at least 8 characters");
    const user = await this.users.findById(userId).select("+passwordHash");
    if (!user) throw new NotFoundException();
    if (user.passwordHash) {
      const ok = await bcrypt.compare(current, user.passwordHash);
      if (!ok) throw new ForbiddenException("Current password is incorrect");
    }
    user.passwordHash = await bcrypt.hash(next, 12);
    user.mustChangePassword = false;
    await user.save();
    await this.audit.log({ actorId: userId, action: "users.password.change", sensitive: true });
    return { ok: true };
  }

  /** Admin-initiated reset — no current password required, audited. */
  async changePasswordForAdmin(userId: string, newPassword: string, actorId: string) {
    if (newPassword.length < 8) throw new BadRequestException("Password must be at least 8 characters");
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException();
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.mustChangePassword = true;
    await user.save();
    await this.audit.log({
      actorId,
      action: "users.password.adminReset",
      targetType: "user",
      targetId: userId,
      sensitive: true,
    });
  }

  async recordLogin(userId: string, ok: boolean, ip?: string, userAgent?: string) {
    await this.users.updateOne(
      { _id: userId },
      { $push: { loginHistory: { $each: [{ at: new Date(), ip, userAgent, ok }], $slice: -25 } } },
    );
  }

  async setSuspended(userId: string, suspended: boolean, actorId: string) {
    const user = await this.users.findByIdAndUpdate(userId, { suspended }, { new: true });
    await this.audit.log({
      actorId,
      action: suspended ? "users.suspend" : "users.reactivate",
      targetType: "user",
      targetId: userId,
      sensitive: true,
    });
    return user;
  }

  private async ownerCount(): Promise<number> {
    return this.users.countDocuments({ role: "owner", suspended: { $ne: true }, deletedAt: { $exists: false } });
  }

  /**
   * Role changes: only the owner may grant/revoke the owner role; admins can
   * manage customer/staff roles. The last active owner can never be demoted.
   * All changes are audited and revoke the target's active sessions.
   */
  async changeRole(targetId: string, newRole: string, actor: { id: string; role: string }) {
    const allowed = ["customer", "staff", "admin", "owner"];
    if (!allowed.includes(newRole)) throw new BadRequestException("Invalid role");
    const target = await this.users.findById(targetId);
    if (!target || target.deletedAt) throw new NotFoundException("User not found");

    if (actor.role !== "owner") {
      if (newRole === "owner" || target.role === "owner") {
        throw new ForbiddenException("Only the owner can change owner roles");
      }
      if (newRole === "admin" && actor.role !== "admin") {
        throw new ForbiddenException("Insufficient authority for this role change");
      }
    }
    if (target.role === "owner" && newRole !== "owner" && (await this.ownerCount()) <= 1) {
      throw new BadRequestException("Cannot demote the last active owner");
    }
    if (targetId === actor.id && target.role === "owner" && newRole !== "owner" && (await this.ownerCount()) <= 1) {
      throw new BadRequestException("Cannot demote the last active owner");
    }

    target.role = newRole as UserDocument["role"];
    target.tokenVersion = (target.tokenVersion ?? 0) + 1; // revoke sessions so new role applies everywhere
    await target.save();
    await this.audit.log({
      actorId: actor.id,
      action: "users.role.change",
      targetType: "user",
      targetId,
      detail: `→ ${newRole}`,
      sensitive: true,
    });
    return target;
  }

  /**
   * Soft deletion: account is suspended, flagged with deletedAt and its
   * sessions revoked. Audit and billing records are preserved; the owner
   * account and the acting user can never be deleted here.
   */
  async deleteUser(targetId: string, actor: { id: string; role: string }) {
    const target = await this.users.findById(targetId);
    if (!target || target.deletedAt) throw new NotFoundException("User not found");
    if (target.role === "owner") throw new BadRequestException("Owner accounts cannot be deleted — demote first");
    if (targetId === actor.id) throw new BadRequestException("You cannot delete your own account here");
    target.deletedAt = new Date();
    target.suspended = true;
    target.tokenVersion = (target.tokenVersion ?? 0) + 1;
    target.email = `deleted+${targetId}@nimbus.invalid`; // release the email for reuse
    target.username = `deleted-${targetId.slice(-8)}`;   // release the username
    await target.save();
    await this.audit.log({
      actorId: actor.id,
      action: "users.delete",
      targetType: "user",
      targetId,
      sensitive: true,
      detail: "soft deletion — audit records preserved",
    });
    return { ok: true };
  }

  /** Ban additionally revokes all active sessions (tokenVersion bump). */
  async setSuspendedWithRevocation(userId: string, suspended: boolean, actorId: string) {
    const user = await this.setSuspended(userId, suspended, actorId);
    if (user && suspended) {
      await this.users.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
    }
    return user;
  }

  async list(filter: Record<string, unknown> = {}, limit = 25, skip = 0) {
    const [items, total] = await Promise.all([
      this.users.find({ deletedAt: { $exists: false }, ...filter }).sort({ createdAt: -1 }).limit(limit).skip(skip),
      this.users.countDocuments(filter),
    ]);
    return { items, total };
  }

  private async availableUsername(base: string): Promise<string> {
    let candidate = base.slice(0, 24) || "user";
    for (let i = 0; i < 50; i++) {
      const taken = await this.users.findOne({ username: candidate });
      if (!taken) return candidate;
      candidate = `${base.slice(0, 20)}${Math.floor(Math.random() * 10000)}`;
    }
    throw new ConflictException("Could not allocate a username");
  }
}
