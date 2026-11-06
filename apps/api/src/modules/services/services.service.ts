import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import type { PowerAction, ServiceStatus } from "@nimbus/shared";
import { canTransition } from "@nimbus/shared";
import { AuditService } from "../audit/audit.service";
import { NodesService } from "../nodes/nodes.service";
import type { AuthUser } from "../../common/auth.decorators";
import { isStaffRole } from "../../common/auth.decorators";
import { Service, ServiceDocument } from "./service.schema";

export interface CreateServiceDto {
  name: string;
  type: string;
  ownerId: string;
  nodeId: string;
  cpuPercent: number;
  ramMb: number;
  diskGb: number;
  dockerImage: string;
  startupCommand?: string[];
  software?: string;
  softwareVersion?: string;
  subdomain?: string;
  expiresAt?: string;
}

@Injectable()
export class ServicesService {
  constructor(
    @InjectModel(Service.name) private readonly services: Model<ServiceDocument>,
    private readonly nodes: NodesService,
    private readonly audit: AuditService,
  ) {}

  async listFor(user: AuthUser, filter: Record<string, unknown> = {}) {
    const query: Record<string, unknown> = isStaffRole(user.role) ? { ...filter } : { ownerId: new Types.ObjectId(user.id), ...filter };
    return this.services.find(query).populate("nodeId", "name location online").limit(200);
  }

  async get(id: string, user: AuthUser): Promise<ServiceDocument> {
    const service = await this.services.findById(id).populate("nodeId", "name ip agentUrl online");
    if (!service) throw new NotFoundException("Service not found");
    const owner = (service.ownerId as Types.ObjectId).toString();
    if (!isStaffRole(user.role) && owner !== user.id) {
      throw new ForbiddenException("You do not own this service");
    }
    return service;
  }

  async create(dto: CreateServiceDto, actor: AuthUser) {
    if (dto.ramMb <= 0 || dto.diskGb <= 0) throw new BadRequestException("Invalid resource limits");
    const node = await this.nodes.get(dto.nodeId);
    if (!node.online || node.maintenanceMode) {
      throw new BadRequestException("Node is offline or in maintenance mode");
    }
    const [ram, disk] = await Promise.all([this.allocatedRam(dto.nodeId), this.allocatedDisk(dto.nodeId)]);
    if (ram + dto.ramMb > node.ramTotalMb) throw new BadRequestException("Insufficient RAM capacity on node");
    if (disk + dto.diskGb > node.diskTotalGb) throw new BadRequestException("Insufficient disk capacity on node");

    const service = await this.services.create({
      ...dto,
      startupCommand: dto.startupCommand ?? [],
      status: "installing" as ServiceStatus,
      subscriptionStatus: "active",
    });
    // Fire install to the node agent; agent confirms with real container state.
    try {
      await this.nodes.agentCall(node, "/services/install", {
        serviceId: service._id!.toString(),
        dockerImage: dto.dockerImage,
        cpuPercent: dto.cpuPercent,
        ramMb: dto.ramMb,
        diskGb: dto.diskGb,
        startupCommand: dto.startupCommand ?? [],
        env: {},
      });
      service.status = "offline";
      service.activity.push({ at: new Date(), action: "install", ok: true });
    } catch (err) {
      service.status = "error";
      service.activity.push({
        at: new Date(),
        action: "install",
        ok: false,
        detail: (err as Error).message,
      });
    }
    await service.save();
    await this.audit.log({
      actorId: actor.id,
      action: "services.create",
      targetType: "service",
      targetId: service._id!.toString(),
      sensitive: true,
    });
    return service;
  }

  /** Start / stop / restart / reinstall with state validation and real node confirmation. */
  async power(id: string, action: PowerAction, actor: AuthUser) {
    const service = await this.get(id, actor);
    if (service.subscriptionStatus !== "active") {
      throw new ForbiddenException("Service is not active");
    }
    if (service.status === "suspended" && isStaffRole(actor.role) === false) {
      throw new ForbiddenException("Service is suspended");
    }
    if (!canTransition(service.status, action)) {
      throw new BadRequestException(`Cannot ${action} a service that is ${service.status}`);
    }
    const node = await this.nodes.get((service.nodeId as Types.ObjectId).toString());
    const before = service.status;
    service.status =
      action === "start" ? "starting" : action === "stop" ? "stopping" : action === "restart" ? "restarting" : "installing";
    service.activity.push({ at: new Date(), action, ok: true });
    await service.save();
    try {
      const result = await this.nodes.agentCall(node, `/services/${service.containerId ?? service._id}/${action}`);
      // Real confirmation replaces the optimistic state.
      service.status = (result?.status as ServiceStatus) ?? (action === "start" ? "online" : action === "stop" ? "offline" : service.status);
      service.activity.push({ at: new Date(), action: `${action}.confirmed`, ok: true });
    } catch (err) {
      service.status = before;
      service.activity.push({ at: new Date(), action: `${action}.failed`, ok: false, detail: (err as Error).message });
      await service.save();
      throw new BadRequestException(`Node did not confirm the ${action} operation`);
    }
    await service.save();
    await this.audit.log({
      actorId: actor.id,
      action: `services.${action}`,
      targetType: "service",
      targetId: id,
      sensitive: action === "reinstall",
    });
    return service;
  }

  async suspend(id: string, actor: AuthUser) {
    const service = await this.services.findByIdAndUpdate(
      id,
      { status: "suspended", subscriptionStatus: "suspended" },
      { new: true },
    );
    await this.audit.log({ actorId: actor.id, action: "services.suspend", targetId: id, sensitive: true });
    return service;
  }

  async expireSweep(): Promise<number> {
    const res = await this.services.updateMany(
      { expiresAt: { $lte: new Date() }, subscriptionStatus: "active" },
      { subscriptionStatus: "expired", status: "suspended" },
    );
    return res.modifiedCount;
  }

  async stats() {
    const [total, active, expired, suspended, byStatus] = await Promise.all([
      this.services.countDocuments(),
      this.services.countDocuments({ status: "online" }),
      this.services.countDocuments({ subscriptionStatus: "expired" }),
      this.services.countDocuments({ status: "suspended" }),
      this.services.aggregate([{ $group: { _id: "$type", count: { $sum: 1 } } }]),
    ]);
    return { total, active, expired, suspended, byType: byStatus };
  }

  private allocatedRam(nodeId: string) {
    return this.services
      .aggregate<{ total: number }>([
        { $match: { nodeId: new Types.ObjectId(nodeId) } },
        { $group: { _id: null, total: { $sum: "$ramMb" } } },
      ])
      .then((r) => (r[0]?.total ?? 0));
  }

  private allocatedDisk(nodeId: string) {
    return this.services
      .aggregate<{ total: number }>([
        { $match: { nodeId: new Types.ObjectId(nodeId) } },
        { $group: { _id: null, total: { $sum: "$diskGb" } } },
      ])
      .then((r) => (r[0]?.total ?? 0));
  }
}
