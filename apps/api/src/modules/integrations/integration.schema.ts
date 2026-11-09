import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

@Schema({ collection: "integration_settings", timestamps: true })
export class IntegrationSetting {
  @Prop({ required: true, unique: true }) key!: string;
  @Prop({ required: true }) encryptedValue!: string;
  @Prop() projectId?: string;
  @Prop() connectedAt?: Date;
  @Prop() updatedBy?: string;
}
export type IntegrationSettingDocument = HydratedDocument<IntegrationSetting>;
export const IntegrationSettingSchema = SchemaFactory.createForClass(IntegrationSetting);
