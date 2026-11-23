import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import type { BackupDestination, BackupStatus } from "@nimbus/shared";

@Schema({ collection: "backups", timestamps: true })
export class Backup {
  @Prop({ type: Types.ObjectId, ref: "Service", required: true, index: true })
  serviceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true })
  ownerId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  requestedBy!: Types.ObjectId;
  @Prop({ enum: ["admin", "customer"], default: "admin", index: true })
  driveOwnerType!: "admin" | "customer";
  @Prop({ type: Types.ObjectId, ref: "User" })
  driveOwnerId?: Types.ObjectId;
  @Prop() backupName?: string;
  @Prop() backupType?: string;
  @Prop({ type: Object }) manifest?: Record<string, unknown>;
  @Prop() verificationStatus?: "pending" | "verified" | "failed";
  @Prop({ type: Object }) encryptionMetadata?: { algorithm: string; iv: string; authTag: string; keyVersion: string };
  @Prop({ enum: ["gdrive", "s3", "local"], required: true }) destination!: BackupDestination;
  @Prop({ enum: ["pending", "running", "completed", "failed"], default: "pending" })
  status!: BackupStatus;
  @Prop() sizeBytes?: number;
  @Prop() checksum?: string; // sha256 integrity verification
  @Prop() remoteFileId?: string;
  @Prop({ type: Types.ObjectId, ref: "User" }) createdBy?: Types.ObjectId;
  @Prop({ enum: ["manual", "scheduled", "pre-update", "pre-reinstall", "pre-restore"], default: "manual" })
  trigger!: string;
  @Prop() error?: string;
  @Prop() completedAt?: Date;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type BackupDocument = HydratedDocument<Backup>;
export const BackupSchema = SchemaFactory.createForClass(Backup);
BackupSchema.index({ createdAt: -1 });

@Schema({ collection: "auditlogs", timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: "User", index: true }) actorId?: Types.ObjectId;
  @Prop({ required: true, index: true }) action!: string;
  @Prop() targetType?: string;
  @Prop() targetId?: string;
  @Prop() ip?: string;
  @Prop({ default: false }) sensitive!: boolean;
  @Prop() detail?: string;
  @Prop() createdAt!: Date;
}

export type AuditLogDocument = HydratedDocument<AuditLog>;
export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ createdAt: -1 });
