import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

@Schema({ collection: "panelbackups", timestamps: true })
export class PanelBackup {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true })
  createdBy!: Types.ObjectId;
  @Prop({ enum: ["running", "completed", "partial", "failed"], default: "running", index: true })
  status!: "running" | "completed" | "partial" | "failed";
  @Prop() customerCount?: number;
  @Prop() serviceCount?: number;
  @Prop() nodeCount?: number;
  @Prop() totalSizeBytes?: number;
  @Prop() databaseFileId?: string;
  @Prop() configurationFileId?: string;
  @Prop() systemMetadataFileId?: string;
  @Prop() manifestFileId?: string;
  @Prop({ type: [{ type: Types.ObjectId, ref: "Backup" }], default: [] })
  serviceBackupIds!: Types.ObjectId[];
  @Prop({ type: Object }) manifest?: Record<string, unknown>;
  @Prop() error?: string;
  @Prop() completedAt?: Date;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type PanelBackupDocument = HydratedDocument<PanelBackup>;
export const PanelBackupSchema = SchemaFactory.createForClass(PanelBackup);
PanelBackupSchema.index({ createdAt: -1 });
