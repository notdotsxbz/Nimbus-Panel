import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import type { DomainScope, DomainVerification } from "@nimbus/shared";

@Schema({ collection: "domains", timestamps: true })
export class Domain {
  @Prop({ required: true, unique: true, lowercase: true, trim: true }) hostname!: string;
  @Prop({ required: true, enum: ["panel", "hosting"] }) scope!: DomainScope;
  @Prop({ type: Types.ObjectId, ref: "User" }) ownerId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "Service" }) serviceId?: Types.ObjectId;
  @Prop({ enum: ["pending", "verified", "failed"], default: "pending" })
  verification!: DomainVerification;
  @Prop({ select: false }) verificationToken?: string;
  @Prop({ enum: ["nimbus-subdomain", "custom", "cloudflare"], default: "custom" })
  source!: string;
  @Prop({
    type: { status: { enum: ["pending", "issued", "failed"] }, expiresAt: Date, provider: String },
  })
  ssl?: { status: "pending" | "issued" | "failed"; expiresAt?: Date; provider?: string };
  @Prop({ type: [{ at: Date, record: String, ok: Boolean }] })
  dnsChecks!: { at: Date; record: string; ok: boolean }[];
  @Prop({ default: false }) suspended!: boolean;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type DomainDocument = HydratedDocument<Domain>;
export const DomainSchema = SchemaFactory.createForClass(Domain);
DomainSchema.index({ ownerId: 1 });
DomainSchema.index({ serviceId: 1 });
