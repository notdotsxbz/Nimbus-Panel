import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

@Schema({ collection: "panelbackupschedules", timestamps: true })
export class PanelBackupSchedule {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, unique: true, index: true })
  ownerId!: Types.ObjectId;
  @Prop({ default: true, index: true }) enabled!: boolean;
  @Prop({ enum: ["daily", "weekly"], required: true })
  frequency!: "daily" | "weekly";
  @Prop({ default: "03:00" }) backupTime!: string;
  @Prop({ default: "UTC" }) timezone!: string;
  @Prop({ default: Date.now, index: true }) nextRunAt!: Date;
  @Prop() lastRunAt?: Date;
  @Prop({ enum: ["queued", "completed", "partial", "failed"] }) lastStatus?: "queued" | "completed" | "partial" | "failed";
  @Prop() lastError?: string;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type PanelBackupScheduleDocument = HydratedDocument<PanelBackupSchedule>;
export const PanelBackupScheduleSchema = SchemaFactory.createForClass(PanelBackupSchedule);
PanelBackupScheduleSchema.index({ enabled: 1, nextRunAt: 1 });
