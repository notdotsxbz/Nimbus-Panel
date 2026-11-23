import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import type { BackupDestination, BackupStatus } from "@nimbus/shared";

@Schema({ collection: "backups", timestamps: true })
export class Backup {
  @Prop({ type: Types.ObjectId, ref: "Service", required: true, index: true })
  serviceId!: Types.ObjectId;
  // Denormalized owner for auditable customer isolation; optional for legacy records.
  @Prop({ type: Types.ObjectId, ref: "User", index: true })
  ownerId?: Types.ObjectId;
  @Prop({ enum: ["customer", "admin"], index: true })
  driveOwnerType?: "customer" | "admin";
  @Prop({ enum: ["gdrive", "s3", "local"], required: true }) destination!: BackupDestination;
  @Prop({ enum: ["pending", "running", "completed", "failed"], default: "pending" })
  status!: BackupStatus;
  @Prop() sizeBytes?: number; // plaintext archive size
  @Prop() storedSizeBytes?: number; // encrypted archive size in Google Drive
  @Prop() checksum?: string; // plaintext SHA-256 integrity verification
  @Prop({ enum: ["aes-256-gcm"] }) encryptionAlgorithm?: "aes-256-gcm";
  @Prop() encryptionIv?: string;
  @Prop() encryptionTag?: string;
  @Prop({ default: false }) localArchiveCleanupPending?: boolean;
  @Prop() remoteFileId?: string;
  @Prop({ type: Types.ObjectId, ref: "User" }) createdBy?: Types.ObjectId;
  @Prop({ enum: ["manual", "scheduled", "pre-update", "pre-reinstall", "pre-restore-safety"], default: "manual" })
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
