import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

@Schema({ collection: "notifications", timestamps: true })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) userId!: Types.ObjectId;
  @Prop({ required: true, trim: true, maxlength: 140 }) title!: string;
  @Prop({ required: true, trim: true, maxlength: 600 }) body!: string;
  @Prop({ enum: ["info", "service", "node", "backup", "deployment", "ticket", "security"], default: "info", index: true })
  type!: string;
  @Prop({ index: true }) readAt?: Date;
  @Prop({ default: false, index: true }) archived!: boolean;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
