import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import type { Protocol } from "@nimbus/shared";

@Schema({ collection: "allocations", timestamps: true })
export class Allocation {
  @Prop({ type: Types.ObjectId, ref: "Node", required: true, index: true }) nodeId!: Types.ObjectId;
  @Prop({ required: true }) ip!: string;
  @Prop({ required: true, min: 1, max: 65535 }) port!: number;
  @Prop({ required: true, enum: ["tcp", "udp"] }) protocol!: Protocol;
  @Prop({ type: Types.ObjectId, ref: "Service" }) serviceId?: Types.ObjectId;
  @Prop({ default: false }) reserved!: boolean;
  @Prop({ type: [{ at: Date, action: String, byUserId: String }] })
  history!: { at: Date; action: string; byUserId?: string }[];
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type AllocationDocument = HydratedDocument<Allocation>;
export const AllocationSchema = SchemaFactory.createForClass(Allocation);
// Uniqueness of (node, ip, port, protocol) — the core conflict check.
AllocationSchema.index(
  { nodeId: 1, ip: 1, port: 1, protocol: 1 },
  { unique: true },
);
