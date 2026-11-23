import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

@Schema({ collection: "backupschedules", timestamps: true })
export class BackupSchedule {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true })
  ownerId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "Service", required: true, unique: true, index: true })
  serviceId!: Types.ObjectId;
  @Prop({ default: true, index: true }) enabled!: boolean;
  @Prop({ enum: ["every6h", "every12h", "daily", "weekly"], required: true })
  frequency!: "every6h" | "every12h" | "daily" | "weekly";
  @Prop({ default: "02:00" }) backupTime!: string;
  @Prop({ default: "UTC" }) timezone!: string;
  @Prop({ enum: ["count", "days", "never"], default: "count" })
  retentionMode!: "count" | "days" | "never";
  @Prop({ enum: [5, 10, 30], default: 5 }) retentionCount!: 5 | 10 | 30;
  @Prop({ min: 1, max: 365 }) retentionDays?: number;
  @Prop({ default: true }) notifyOnCompletion!: boolean;
  @Prop({ default: Date.now, index: true }) nextRunAt!: Date;
  @Prop() lastRunAt?: Date;
  @Prop({ enum: ["running", "completed", "failed"] }) lastStatus?: "running" | "completed" | "failed";
  @Prop() lastError?: string;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type BackupScheduleDocument = HydratedDocument<BackupSchedule>;
export const BackupScheduleSchema = SchemaFactory.createForClass(BackupSchedule);
BackupScheduleSchema.index({ enabled: 1, nextRunAt: 1 });
