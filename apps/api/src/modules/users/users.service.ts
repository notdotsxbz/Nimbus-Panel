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
      .findOne({ $or: [{ email: identifier }, { username: identifier }] })
      .select("+passwordHash");
    if (!user?.passwordHash) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    return ok ? user : null;
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

  async list(filter: Record<string, unknown> = {}, limit = 25, skip = 0) {
    const [items, total] = await Promise.all([
      this.users.find(filter).sort({ createdAt: -1 }).limit(limit).skip(skip),
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
