import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import type { Role } from "@nimbus/shared";

@Schema({ collection: "users", timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true }) email!: string;
  @Prop({ required: true, unique: true, lowercase: true, trim: true }) username!: string;
  @Prop({ select: false }) passwordHash?: string; // bcrypt; absent for Firebase-only users
  @Prop({ required: true, enum: ["owner", "admin", "staff", "customer"], default: "customer" })
  role!: Role;
  @Prop({ default: false }) mustChangePassword!: boolean;
  @Prop({ default: false }) suspended!: boolean;
  @Prop() firebaseUid?: string;
  @Prop() displayName?: string;
  @Prop({ type: [{ at: Date, ip: String, userAgent: String, ok: Boolean }] })
  loginHistory!: { at: Date; ip?: string; userAgent?: string; ok: boolean }[];
  @Prop({ type: Map, of: String, default: {} }) twoFactor?: Map<string, string>;
  // Bumped on ban/credential reset — JWTs carrying an older version are
  // rejected by the auth guard, revoking active sessions immediately.
  @Prop({ default: 0, select: false }) tokenVersion!: number;
  // Soft deletion: suspended + flagged; audit/financial records are kept.
  @Prop() deletedAt?: Date;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

// Case-insensitive uniqueness is enforced by lowercase + unique indexes above.
UserSchema.index({ username: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
UserSchema.index({ email: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
UserSchema.index({ firebaseUid: 1 });
