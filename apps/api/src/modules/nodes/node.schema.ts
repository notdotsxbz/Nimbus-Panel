import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import type { NodeHeartbeat } from "@nimbus/shared";

@Schema({ collection: "nodes", timestamps: true })
export class Node {
  @Prop({ required: true, unique: true }) name!: string;
  @Prop({ required: true }) ip!: string;
  @Prop({ default: 22 }) sshPort!: number;
  @Prop({ default: "root" }) sshUsername!: string;
  @Prop() sshKeyFingerprint?: string; // never store raw private keys on the control plane
  @Prop() os?: string; // ubuntu | debian
  @Prop() location?: string;
  @Prop({ required: true }) agentUrl!: string; // https://node-ip:7443
  @Prop({ select: false }) agentTokenHash?: string; // sha256 of per-node credential
  @Prop({ required: true }) cpuCores!: number;
  @Prop({ required: true }) ramTotalMb!: number;
  @Prop({ required: true }) diskTotalGb!: number;
  @Prop({ default: false }) online!: boolean;
  @Prop() lastHeartbeatAt?: Date;
  // Interface-typed embedded document — mongoose needs the explicit raw type.
  @Prop({ type: Object }) lastHeartbeat?: NodeHeartbeat;
  @Prop({ default: false }) maintenanceMode!: boolean;
  @Prop({ default: "active" }) status!: "enrolling" | "active" | "maintenance" | "retired";
  @Prop({ type: [String], default: [] }) tags!: string[];
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type NodeDocument = HydratedDocument<Node>;
export const NodeSchema = SchemaFactory.createForClass(Node);
NodeSchema.index({ online: 1 });
NodeSchema.index({ status: 1 });
