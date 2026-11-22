import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

@Schema({ collection: "software_versions", timestamps: true })
export class SoftwareVersion {
  @Prop({ type: Types.ObjectId, ref: "Software", required: true, index: true }) softwareId!: Types.ObjectId;
  @Prop({ required: true, trim: true }) version!: string;
  @Prop({ default: "" }) releaseName!: string;
  @Prop() releaseDate?: Date;
  @Prop({ default: "stable" }) channel!: string;
  @Prop({ default: false }) prerelease!: boolean;
  @Prop({ default: false }) recommended!: boolean;
  @Prop({ default: false }) deprecated!: boolean;
  @Prop({ default: "pending", enum: ["pending", "published", "disabled"] }) publicationStatus!: string;
  @Prop({ default: "" }) sourceUrl!: string;
  @Prop({ default: "" }) sourceId!: string;
  @Prop({ type: [String], default: [] }) compatibility!: string[];
  @Prop({ type: [String], default: [] }) architectures!: string[];
  @Prop({ type: [String], default: [] }) operatingSystems!: string[];
  @Prop({ default: true }) compatible!: boolean;
  @Prop({ type: [String], default: [] }) incompatibilityReasons!: string[];
  @Prop({ type: Object, default: {} }) runtimeRequirements!: Record<string, unknown>;
  @Prop({ default: "" }) checksum!: string;
  @Prop({ default: "" }) signature!: string;
  @Prop({ type: Object, default: {} }) metadata!: Record<string, unknown>;
  @Prop({ default: null }) importedAt?: Date;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}
export type SoftwareVersionDocument = HydratedDocument<SoftwareVersion>;
export const SoftwareVersionSchema = SchemaFactory.createForClass(SoftwareVersion);
SoftwareVersionSchema.index({ softwareId: 1, version: 1 }, { unique: true });
SoftwareVersionSchema.index({ softwareId: 1, publicationStatus: 1 });
