import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import type { Protocol } from "@nimbus/shared";
import { env } from "../../config/env";
import { AuditService } from "../audit/audit.service";
import { Allocation, AllocationDocument } from "./allocation.schema";

@Injectable()
export class AllocationsService {
  constructor(
    @InjectModel(Allocation.name) private readonly allocations: Model<AllocationDocument>,
    private readonly audit: AuditService,
  ) {}

  async list(filter: Record<string, unknown> = {}) {
    return this.allocations.find(filter).populate("serviceId", "name type").limit(200);
  }

  /** Automatic allocation inside the configured range with conflict checking. */
  async autoAllocate(nodeId: string, ip: string, protocol: Protocol, actorId: string) {
    const used = await this.allocations.find({ nodeId, ip, protocol }, "port");
    const taken = new Set(used.map((a) => a.port));
    for (let port = env.portRangeStart; port <= env.portRangeEnd; port++) {
      if (!taken.has(port)) {
        return this.allocate(nodeId, ip, port, protocol, actorId);
      }
    }
    throw new ConflictException(`No free ports in range ${env.portRangeStart}–${env.portRangeEnd} on ${ip}`);
  }

  /** Manual allocation with full uniqueness check on (node, ip, port, protocol). */
  async allocate(nodeId: string, ip: string, port: number, protocol: Protocol, actorId: string) {
    if (port < 1024 || port > 65535) throw new BadRequestException("Port out of range");
    const clash = await this.allocations.findOne({ nodeId, ip, port, protocol });
    if (clash) throw new ConflictException("That node/ip/port/protocol combination is already allocated");
    const allocation = await this.allocations.create({
      nodeId: new Types.ObjectId(nodeId),
      ip,
      port,
      protocol,
      history: [{ at: new Date(), action: "allocate", byUserId: actorId }],
    });
    await this.audit.log({
      actorId,
      action: "allocations.allocate",
      targetType: "allocation",
      targetId: allocation._id!.toString(),
      detail: `${ip}:${port}/${protocol}`,
      sensitive: true,
    });
    return allocation;
  }

  async release(id: string, actorId: string) {
    const allocation = await this.allocations.findById(id);
    if (!allocation) throw new BadRequestException("Unknown allocation");
    if (allocation.serviceId) throw new BadRequestException("Release the service allocation first");
    allocation.reserved = false;
    allocation.history.push({ at: new Date(), action: "release", byUserId: actorId });
    await allocation.deleteOne();
    await this.audit.log({ actorId, action: "allocations.release", targetId: id, sensitive: true });
    return { ok: true };
  }

  async assignToService(id: string, serviceId: string) {
    return this.allocations.findByIdAndUpdate(id, { serviceId }, { new: true });
  }
}
