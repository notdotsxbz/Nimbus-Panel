import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import type { BackupDestination, BackupStatus } from "@nimbus/shared";

@Schema({ collection: "backups", timestamps: true })
export class Backup {
  @Prop({ type: Types.ObjectId, ref: "Service", required: true, index: true })
  serviceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "BackupJob", index: true })
  jobId?: Types.ObjectId;
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
BackupSchema.index({ jobId: 1, serviceId: 1 }, { unique: true, sparse: true });

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

@Schema({ timestamps: true })
export class BackupSchedule {
  @Prop({ type: Types.ObjectId, ref: "Service", required: true, unique: true, index: true })
  serviceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true })
  ownerId!: Types.ObjectId;
  @Prop({ default: false })
  enabled!: boolean;
  @Prop({ enum: ["manual", "every6h", "every12h", "daily", "weekly"], default: "manual" })
  frequency!: "manual" | "every6h" | "every12h" | "daily" | "weekly";
  @Prop({ default: "02:00" })
  time!: string;
  @Prop({ enum: [0, 5, 10, 30], default: 5 })
  retention!: 0 | 5 | 10 | 30;
  @Prop({ default: true })
  notifyOnCompletion!: boolean;
  @Prop()
  nextRunAt?: Date;
  @Prop()
  lastRunAt?: Date;
  @Prop()
  leaseUntil?: Date;
}
export const BackupScheduleSchema = SchemaFactory.createForClass(BackupSchedule);
export type BackupScheduleDocument = HydratedDocument<BackupSchedule>;

@Schema({ collection: "backupjobs", timestamps: true })
export class BackupJob {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true })
  requestedBy!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true })
  ownerId!: Types.ObjectId;
  @Prop({ enum: ["customer", "admin"], required: true })
  ownerType!: "customer" | "admin";
  @Prop({ enum: ["customer", "admin", "owner", "staff"], required: true })
  requesterRole!: string;
  @Prop({ type: [Types.ObjectId], ref: "Service", required: true })
  serviceIds!: Types.ObjectId[];
  @Prop({ enum: ["manual", "scheduled", "admin-batch"], default: "manual" })
  trigger!: string;
  @Prop({ enum: ["gdrive", "local"], default: "gdrive" })
  destination!: string;
  @Prop({ enum: ["queued", "running", "completed", "failed"], default: "queued", index: true })
  status!: "queued" | "running" | "completed" | "failed";
  @Prop({ default: 0 })
  total!: number;
  @Prop({ default: 0 })
  completed!: number;
  @Prop({ default: 0 })
  failed!: number;
  @Prop({ type: Types.ObjectId, ref: "Service" })
  currentServiceId?: Types.ObjectId;
  @Prop({ type: [Object], default: [] })
  results!: Array<{ serviceId: string; status: string; backupId?: string; error?: string }>;
  @Prop()
  leaseUntil?: Date;
  @Prop()
  startedAt?: Date;
  @Prop()
  completedAt?: Date;
}
export const BackupJobSchema = SchemaFactory.createForClass(BackupJob);
export type BackupJobDocument = HydratedDocument<BackupJob>;
