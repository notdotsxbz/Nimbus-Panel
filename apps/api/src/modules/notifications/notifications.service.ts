import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Notification, NotificationDocument } from "./notification.schema";

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<NotificationDocument>,
  ) {}

  async list(userId: string, limit = 50) {
    return this.notifications
      .find({ userId: new Types.ObjectId(userId), archived: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  async unreadCount(userId: string): Promise<number> {
    return this.notifications.countDocuments({
      userId: new Types.ObjectId(userId),
      readAt: { $exists: false },
      archived: { $ne: true },
    });
  }

  async markRead(userId: string, id: string) {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new BadRequestException("Invalid notification id");
    const n = await this.notifications.findOne({ _id: id, userId: new Types.ObjectId(userId) });
    if (!n) throw new NotFoundException("Notification not found");
    if (!n.readAt) {
      n.readAt = new Date();
      await n.save();
    }
    return n;
  }

  async markAllRead(userId: string) {
    const res = await this.notifications.updateMany(
      { userId: new Types.ObjectId(userId), readAt: { $exists: false } },
      { $set: { readAt: new Date() } },
    );
    return { updated: res.modifiedCount };
  }

  /** Notify a single user (used by other modules for service/ticket events). */
  async notify(userId: string, type: string, title: string, body: string) {
    return this.notifications.create({
      userId: new Types.ObjectId(userId),
      type,
      title,
      body,
    });
  }

  /** Admin broadcast to every active account. */
  async broadcast(actorId: string, dto: { title?: unknown; body?: unknown; type?: unknown }) {
    const title = typeof dto.title === "string" ? dto.title.trim() : "";
    const body = typeof dto.body === "string" ? dto.body.trim() : "";
    if (title.length < 3 || title.length > 140) throw new BadRequestException("Title must be 3–140 characters");
    if (body.length < 1 || body.length > 600) throw new BadRequestException("Body must be 1–600 characters");
    const type = ["info", "service", "node", "backup", "deployment", "ticket", "security"].includes(String(dto.type))
      ? String(dto.type)
      : "info";
    const users = await this.notifications.db
      .collection("users")
      .find({ deletedAt: { $exists: false }, suspended: { $ne: true } }, { projection: { _id: 1 } })
      .toArray();
    if (users.length > 0) {
      await this.notifications.insertMany(
        users.map((u) => ({ userId: u._id, type, title, body })),
      );
    }
    return { delivered: users.length };
  }
}
