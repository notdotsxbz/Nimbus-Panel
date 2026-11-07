import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import type { ThemeColors } from "@nimbus/shared";

@Schema({ collection: "themes", timestamps: true })
export class Theme {
  @Prop({ required: true, unique: true }) key!: string; // slug id, e.g. "ocean-blue" or "custom-abc123"
  @Prop({ required: true }) name!: string;
  @Prop() description?: string;
  @Prop({ required: true, type: Object }) colors!: ThemeColors;
  @Prop({ enum: ["light", "dark"], required: true, default: "dark" }) mode!: "light" | "dark";
  @Prop({ default: false, index: true }) isBuiltIn!: boolean;
  @Prop({ default: false, index: true }) isPublished!: boolean;
  @Prop({ type: Types.ObjectId, ref: "User" }) createdBy?: Types.ObjectId;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type ThemeDocument = HydratedDocument<Theme>;
export const ThemeSchema = SchemaFactory.createForClass(Theme);
ThemeSchema.index({ isPublished: 1, isBuiltIn: 1 });

/** Singleton global settings document (fixed _id). */
@Schema({ collection: "appearanceSettings" })
export class AppearanceSettings {
  @Prop({ required: true }) settingsId!: string; // always "global"
  @Prop({ default: true }) allowCustomerThemes!: boolean;
  @Prop({ default: true }) allowCustomerAnimations!: boolean;
  @Prop({ default: "nimbus-dark" }) defaultThemeKey!: string;
  @Prop({ default: "smooth" }) defaultAnimationPreset!: string;
  @Prop({ default: true }) animationsEnabled!: boolean;
  @Prop({ type: Number, default: 1 }) animationSpeed!: number; // 0.5–1.5
  @Prop({ type: Number, default: 0.8 }) animationIntensity!: number; // 0–1.2
  @Prop({ default: false }) allowCustomThemes!: boolean;
  @Prop() updatedAt!: Date;
}

export type AppearanceSettingsDocument = HydratedDocument<AppearanceSettings>;
export const AppearanceSettingsSchema = SchemaFactory.createForClass(AppearanceSettings);
AppearanceSettingsSchema.index({ settingsId: 1 }, { unique: true });

/** Per-user appearance preferences (customers AND admins). */
@Schema({ collection: "userAppearance", timestamps: true })
export class UserAppearance {
  @Prop({ required: true, unique: true, index: true }) userId!: Types.ObjectId;
  @Prop() themeKey?: string;
  @Prop({ enum: ["light", "dark", "system"], default: "system" }) colorMode!: "light" | "dark" | "system";
  @Prop({ default: true }) animationsEnabled!: boolean;
  @Prop({ default: false }) reducedMotion!: boolean;
  @Prop() animationPreset?: string;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type UserAppearanceDocument = HydratedDocument<UserAppearance>;
export const UserAppearanceSchema = SchemaFactory.createForClass(UserAppearance);
