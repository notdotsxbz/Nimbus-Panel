import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export type TicketStatus = "open" | "in_progress" | "waiting" | "closed";
export type TicketPriority = "low" | "normal" | "high";

export interface TicketMessage {
  authorId: Types.ObjectId;
  authorRole: string;
  body: string;
  at: Date;
}

@Schema({ collection: "tickets", timestamps: true })
export class Ticket {
  @Prop({ required: true, trim: true, maxlength: 120 }) subject!: string;
  @Prop({ enum: ["open", "in_progress", "waiting", "closed"], default: "open", index: true })
  status!: TicketStatus;
  @Prop({ enum: ["low", "normal", "high"], default: "normal" }) priority!: TicketPriority;
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) ownerId!: Types.ObjectId;
  @Prop({ required: true, type: [{ authorId: Types.ObjectId, authorRole: String, body: String, at: Date }] })
  messages!: TicketMessage[];
  @Prop({ type: Types.ObjectId, ref: "User", index: true }) assignedTo?: Types.ObjectId;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}

export type TicketDocument = HydratedDocument<Ticket>;
export const TicketSchema = SchemaFactory.createForClass(Ticket);
TicketSchema.index({ status: 1, updatedAt: -1 });
