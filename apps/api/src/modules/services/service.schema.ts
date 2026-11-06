import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import type { ServiceStatus, ServiceType } from "@nimbus/shared";

@Schema({ collection: "services", timestamps: true })
export class Service {
  @Prop({ required: true }) name!: string;
  @Prop({ required: true, index: true }) type!: ServiceType;
  @Prop({ required: true, enum: [
    "online", "offline", "starting", "stopping", "restarting",
    "installing", "updating", "suspended", "error",
  ], default: "installing" })
  status!: ServiceStatus;
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) ownerId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "Node", required: true, index: true }) nodeId!: Types.ObjectId;
  @Prop() containerId?: string;
  @Prop({ required: true }) cpuPercent!: number;
  @Prop({ required: true }) ramMb!: number;
  @Prop({ required: true }) diskGb!: number;
  @Prop({ default: 1 }) swapMb!: number;
  @Prop() dockerImage!: string;
  @Prop({ type: [String], default: [] }) startupCommand!: string[];
  @Prop({ type: Map, of: String, default: {} }) envVars!: Map<string, string>; // encrypted at rest by field-level hook
  @Prop() software?: string; // paper, vanilla, nodejs20, python312, …
  @Prop() softwareVersion?: string;
  @Prop() primaryAllocationId?: string;
  @Prop() subdomain?: string;
  @Prop() customDomain?: string;
  @Prop() expiresAt?: Date;
  @Prop({ default: "active" }) subscriptionStatus!: "active" | "expired" | "suspended";
  @Prop({ type: Map, of: String, default: {} }) recoveryPolicy!: Map<string, string>;
  @Prop({ default: 0 }) crashCount!: number;
  @Prop() lastCrashAt?: Date;
  @Prop({ type: [{ at: Date, action: String, ok: Boolean, detail: String }] })
  activity!: { at: Date; action: string; ok: boolean; detail?: string }[];
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type ServiceDocument = HydratedDocument<Service>;
export const ServiceSchema = SchemaFactory.createForClass(Service);
ServiceSchema.index({ ownerId: 1, type: 1 });
ServiceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // index for expiration sweep jobs
