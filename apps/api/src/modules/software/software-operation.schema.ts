import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

@Schema({ collection: "software_operations", timestamps: true })
export class SoftwareOperation {
  @Prop({ type: Types.ObjectId, ref: "Service", required: true, index: true }) serviceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) requestedBy!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "Software", required: true }) softwareId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "SoftwareVersion", required: true }) versionId!: Types.ObjectId;
  @Prop({ default: "" }) previousSoftware!: string;
  @Prop({ default: "" }) previousVersion!: string;
  @Prop({ required: true }) requestedSoftware!: string;
  @Prop({ required: true }) requestedVersion!: string;
  @Prop({ enum: ["pending", "backing-up", "updating", "verifying", "completed", "failed", "cancelled"], default: "pending", index: true }) status!: string;
  @Prop({ default: 0 }) progress!: number;
  @Prop({ default: "" }) error!: string;
  @Prop({ type: Object, default: {} }) verification!: Record<string, unknown>;
  @Prop() backupId?: string;
  @Prop() startedAt?: Date;
  @Prop() completedAt?: Date;
}
export type SoftwareOperationDocument = HydratedDocument<SoftwareOperation>;
export const SoftwareOperationSchema = SchemaFactory.createForClass(SoftwareOperation);
SoftwareOperationSchema.index({ serviceId: 1, createdAt: -1 });
