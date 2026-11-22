import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

@Schema({ collection: "software_sync_jobs", timestamps: true })
export class SoftwareSyncJob {
  @Prop({ type: Types.ObjectId, ref: "Software", required: true, index: true }) softwareId!: Types.ObjectId;
  @Prop({ required: true, unique: true, trim: true }) jobKey!: string;
  @Prop({ enum: ["queued", "running", "retry", "completed", "failed"], default: "queued", index: true }) status!: string;
  @Prop({ default: 0 }) attempts!: number;
  @Prop({ default: 5 }) maxAttempts!: number;
  @Prop({ type: Date, default: Date.now, index: true }) runAt!: Date;
  @Prop({ type: Date, default: null, index: true }) leaseUntil?: Date | null;
  @Prop({ type: Date, default: null }) startedAt?: Date;
  @Prop({ type: Date, default: null }) completedAt?: Date;
  @Prop({ default: "" }) lastError!: string;
  @Prop({ default: 0 }) discovered!: number;
  @Prop({ default: 0 }) imported!: number;
  @Prop({ default: 0 }) skipped!: number;
  @Prop({ default: 0 }) failed!: number;
}
export type SoftwareSyncJobDocument = HydratedDocument<SoftwareSyncJob>;
export const SoftwareSyncJobSchema = SchemaFactory.createForClass(SoftwareSyncJob);
SoftwareSyncJobSchema.index({ status: 1, runAt: 1, createdAt: 1 });
SoftwareSyncJobSchema.index({ softwareId: 1, createdAt: -1 });