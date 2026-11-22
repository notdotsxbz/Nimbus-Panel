import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export const SOFTWARE_SOURCE_TYPES = ["manual", "github-releases", "nodejs-index", "go-index", "modrinth", "dockerhub-tags"] as const;
export type SoftwareSourceType = (typeof SOFTWARE_SOURCE_TYPES)[number];

@Schema({ collection: "software_catalog", timestamps: true })
export class Software {
  @Prop({ required: true, trim: true }) name!: string;
  @Prop({ required: true, unique: true, lowercase: true, trim: true, index: true }) identifier!: string;
  @Prop({ default: "" }) description!: string;
  @Prop({ default: "runtime" }) category!: string;
  @Prop({ type: [String], required: true, index: true }) serviceTypes!: string[];
  @Prop({ enum: SOFTWARE_SOURCE_TYPES, default: "manual" }) sourceType!: SoftwareSourceType;
  @Prop({ type: Object, default: {} }) sourceConfig!: Record<string, string>;
  @Prop({ type: Object, default: {} }) installationConfig!: Record<string, unknown>;
  @Prop({ default: true }) enabled!: boolean;
  @Prop({ default: true }) customerAvailable!: boolean;
  @Prop({ default: false }) autoSync!: boolean;
  @Prop({ enum: ["manual", "6h", "12h", "24h", "7d"], default: "manual" }) syncFrequency!: string;
  @Prop({ default: false }) autoPublish!: boolean;
  @Prop({ type: Types.ObjectId, ref: "SoftwareVersion", default: null }) recommendedVersionId?: Types.ObjectId;
  @Prop({ default: null }) lastSyncedAt?: Date;
  @Prop({ default: null }) lastSyncAttemptAt?: Date;
  @Prop({ default: null }) nextSyncAt?: Date;
  @Prop({ type: Date, default: null }) syncLeaseUntil?: Date | null;
  @Prop({ default: "never" }) lastSyncStatus!: string;
  @Prop({ type: [Object], default: [] }) discoveryPreview!: Record<string, unknown>[];
  @Prop({ type: Date, default: null }) discoveryPreviewAt?: Date;
  @Prop({ type: [{ startedAt: Date, completedAt: Date, status: String, discovered: Number, imported: Number, skipped: Number, failed: Number, error: String }], default: [] })
  syncHistory!: { startedAt: Date; completedAt?: Date; status: string; discovered?: number; imported?: number; skipped?: number; failed?: number; error?: string }[];
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}
export type SoftwareDocument = HydratedDocument<Software>;
export const SoftwareSchema = SchemaFactory.createForClass(Software);
SoftwareSchema.index({ serviceTypes: 1, enabled: 1, customerAvailable: 1 });
