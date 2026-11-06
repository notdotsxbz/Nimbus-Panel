import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { AuditLog, AuditLogDocument } from "../backups/backup.schema";

export interface AuditEntry {
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  sensitive?: boolean;
  detail?: string;
}

/** Append-only audit trail — every sensitive operation flows through here. */
@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditLog.name) private readonly logs: Model<AuditLogDocument>) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.logs.create(entry);
    } catch {
      // Auditing must never break the request path; surface via stderr.
      console.error("[audit] failed to persist", entry.action);
    }
  }

  async find(filter: Record<string, unknown> = {}, limit = 50, skip = 0) {
    return this.logs.find(filter).sort({ createdAt: -1 }).limit(limit).skip(skip).lean();
  }
}
