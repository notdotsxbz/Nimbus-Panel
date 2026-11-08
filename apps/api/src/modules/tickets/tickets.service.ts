import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { AuditService } from "../audit/audit.service";
import { Ticket, TicketDocument, TicketStatus } from "./ticket.schema";

const STATUSES: TicketStatus[] = ["open", "in_progress", "waiting", "closed"];

@Injectable()
export class TicketsService {
  constructor(
    @InjectModel(Ticket.name) private readonly tickets: Model<TicketDocument>,
    private readonly audit: AuditService,
  ) {}

  private assertBody(body: unknown): string {
    if (typeof body !== "string" || body.trim().length < 1 || body.trim().length > 4000) {
      throw new BadRequestException("Message must be 1–4000 characters");
    }
    return body.trim();
  }

  /** Any authenticated user can create a ticket for themselves. */
  async create(ownerId: string, ownerRole: string, dto: { subject?: unknown; body?: unknown; priority?: unknown }) {
    const subject = typeof dto.subject === "string" ? dto.subject.trim() : "";
    if (subject.length < 3 || subject.length > 120) {
      throw new BadRequestException("Subject must be 3–120 characters");
    }
    const body = this.assertBody(dto.body);
    const priority = ["low", "normal", "high"].includes(String(dto.priority)) ? (String(dto.priority) as Ticket["priority"]) : "normal";
    const ticket = await this.tickets.create({
      subject,
      priority,
      ownerId: new Types.ObjectId(ownerId),
      messages: [{ authorId: new Types.ObjectId(ownerId), authorRole: ownerRole, body, at: new Date() }],
    });
    await this.audit.log({ actorId: ownerId, action: "tickets.create", targetType: "ticket", targetId: ticket._id!.toString() });
    return ticket;
  }

  /** Customers see only their own tickets; staff sees all. */
  async listFor(user: { id: string; role: string }, status?: string) {
    const filter: Record<string, unknown> = {};
    if (!["owner", "admin", "staff"].includes(user.role)) filter.ownerId = new Types.ObjectId(user.id);
    if (status && STATUSES.includes(status as TicketStatus)) filter.status = status;
    return this.tickets.find(filter).sort({ updatedAt: -1 }).limit(100).populate("ownerId", "username email");
  }

  /** Ownership enforced: only the ticket owner or staff may read it. */
  async get(id: string, user: { id: string; role: string }) {
    const ticket = await this.tickets.findById(id).populate("ownerId", "username email");
    if (!ticket) throw new NotFoundException("Ticket not found");
    const isStaff = ["owner", "admin", "staff"].includes(user.role);
    if (!isStaff && ticket.ownerId._id.toString() !== user.id) {
      throw new ForbiddenException("This ticket belongs to another customer");
    }
    return ticket;
  }

  async reply(id: string, user: { id: string; role: string }, body: unknown) {
    const ticket = await this.get(id, user); // ownership check inside
    const text = this.assertBody(body);
    if (ticket.status === "closed" && !["owner", "admin", "staff"].includes(user.role)) {
      throw new ForbiddenException("This ticket is closed");
    }
    ticket.messages.push({ authorId: new Types.ObjectId(user.id), authorRole: user.role, body: text, at: new Date() });
    // Customer reply moves a staff-waiting ticket back into the queue.
    if (!["owner", "admin", "staff"].includes(user.role) && ticket.status !== "closed") {
      ticket.status = "open";
    }
    await ticket.save();
    return ticket;
  }

  /** Staff-only status transitions. */
  async setStatus(id: string, user: { id: string; role: string }, status: unknown) {
    if (!["owner", "admin", "staff"].includes(user.role)) {
      throw new ForbiddenException("Only staff can change ticket status");
    }
    if (!STATUSES.includes(String(status) as TicketStatus)) {
      throw new BadRequestException("Invalid status");
    }
    const ticket = await this.tickets.findById(id);
    if (!ticket) throw new NotFoundException("Ticket not found");
    ticket.status = String(status) as TicketStatus;
    await ticket.save();
    await this.audit.log({ actorId: user.id, action: "tickets.status", targetId: id, detail: String(status) });
    return ticket;
  }

  async stats() {
    const [open, inProgress, waiting, closed] = await Promise.all([
      this.tickets.countDocuments({ status: "open" }),
      this.tickets.countDocuments({ status: "in_progress" }),
      this.tickets.countDocuments({ status: "waiting" }),
      this.tickets.countDocuments({ status: "closed" }),
    ]);
    return { open, inProgress, waiting, closed, total: open + inProgress + waiting + closed };
  }
}
