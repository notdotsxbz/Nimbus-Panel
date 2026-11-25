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
import { User, UserDocument } from "../users/user.schema";

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
  envVars?: Record<string, string>;
  software?: string;
  softwareVersion?: string;
  subdomain?: string;
  expiresAt?: string;
  versionProbe?: string;
  expectedVersion?: string;
}

@Injectable()
export class ServicesService {
  constructor(
    @InjectModel(Service.name) private readonly services: Model<ServiceDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly nodes: NodesService,
    private readonly audit: AuditService,
  ) {}

  /** Customers see only their own services; staff sees all. */
  async listFor(user: AuthUser, filter: Record<string, unknown> = {}) {
    const query: Record<string, unknown> = isStaffRole(user.role) ? { ...filter } : { ownerId: new Types.ObjectId(user.id), ...filter };
    return this.services.find(query).populate("nodeId", "name location online").limit(200);
  }

  /** Ownership-enforced read — the base for every per-service operation. */
  async get(id: string, user: AuthUser): Promise<ServiceDocument> {
    const service = await this.services.findById(id);
    if (!service) throw new NotFoundException("Service not found");
    const owner = (service.ownerId as Types.ObjectId).toString();
    if (!isStaffRole(user.role) && owner !== user.id) {
      throw new ForbiddenException("You do not own this service");
    }
    return service;
  }

  async create(dto: CreateServiceDto, actor: AuthUser) {
    if (dto.ramMb <= 0 || dto.diskGb <= 0) throw new BadRequestException("Invalid resource limits");
    if (["vps", "vds"].includes(String(dto.type ?? "").toLowerCase())) throw new BadRequestException("VPS/VDS provisioning is unavailable until a KVM/libvirt provider and virtualization Node Agent are installed and verified. This endpoint provisions Docker workloads only.");
    const customer = await this.users.findById(dto.ownerId);
    if (!customer || customer.role !== "customer" || customer.suspended || customer.deletedAt) throw new BadRequestException("Choose an active customer account");
    const node = await this.nodes.get(dto.nodeId);
    if (!node.online || node.maintenanceMode) {
      throw new BadRequestException("Node is offline or in maintenance mode");
    }
    const [ram, disk] = await Promise.all([this.allocatedRam(dto.nodeId), this.allocatedDisk(dto.nodeId)]);
    if (ram + dto.ramMb > node.ramTotalMb) throw new BadRequestException("Insufficient RAM capacity on node");
    if (disk + dto.diskGb > node.diskTotalGb) throw new BadRequestException("Insufficient disk capacity on node");

    const service = await this.services.create({
      ...dto,
      ownerId: new Types.ObjectId(dto.ownerId),
      nodeId: new Types.ObjectId(dto.nodeId),
      startupCommand: dto.startupCommand ?? [],
      status: "installing" as ServiceStatus,
      subscriptionStatus: "active",
    });
    // Fire install to the node agent; agent confirms with real container state.
    try {
      const installed = await this.nodes.agentCall(node, `/services/${service._id!.toString()}/install`, {
        dockerImage: dto.dockerImage,
        cpuPercent: dto.cpuPercent,
        ramMb: dto.ramMb,
        diskGb: dto.diskGb,
        startupCommand: dto.startupCommand ?? [],
        env: dto.envVars ?? {},
        versionProbe: dto.versionProbe ?? "",
        expectedVersion: dto.expectedVersion ?? "",
      }, "POST", 120_000) as { status?: string; containerId?: string; installedImage?: string; running?: boolean; environmentVerified?: boolean; versionVerified?: boolean };
      if (installed.status !== "online" || installed.running !== true || installed.installedImage !== dto.dockerImage || !installed.containerId || (dto.versionProbe && installed.versionVerified !== true) || (Object.keys(dto.envVars ?? {}).length > 0 && installed.environmentVerified !== true)) {
        throw new BadRequestException("Node Agent did not verify the newly installed container");
      }
      service.containerId = installed.containerId;
      service.status = "online";
      service.activity.push({ at: new Date(), action: "install", ok: true, detail: "container=" + installed.containerId });
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
    if (service.expiresAt && service.expiresAt.getTime() <= Date.now()) {
      throw new ForbiddenException("Service allocation has expired");
    }
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
      const result = await this.nodes.agentCall(node, `/services/${service._id}/${action}`);
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

  /** Owner-only reassignment controls which customer can access this service. */
  async assignOwner(id: string, ownerId: string, actor: AuthUser) {
    if (!Types.ObjectId.isValid(ownerId)) throw new BadRequestException("Invalid customer ID");
    const [service, customer] = await Promise.all([this.services.findById(id), this.users.findById(ownerId)]);
    if (!service) throw new NotFoundException("Service not found");
    if (!customer || customer.role !== "customer" || customer.suspended || customer.deletedAt) throw new BadRequestException("Choose an active customer account");
    service.ownerId = new Types.ObjectId(ownerId);
    await service.save();
    await this.audit.log({ actorId: actor.id, action: "services.assignOwner", targetType: "service", targetId: id, detail: `Access assigned to user ${ownerId}`, sensitive: true });
    return service;
  }

  /** Time-limited allocations are validated server-side, not only in the UI. */
  async setExpiry(id: string, days: number | null | undefined, actor: AuthUser) {
    if (days !== null && (!Number.isInteger(days) || days === undefined || days < 1 || days > 3650)) {
      throw new BadRequestException("Duration must be 1–3650 days, or null for unlimited");
    }
    const service = await this.get(id, actor);
    service.expiresAt = days === null ? undefined : new Date(Date.now() + days! * 86_400_000);
    // Extending an expired allocation does not automatically restart a stopped container.
    if (service.subscriptionStatus === "expired" && (!service.expiresAt || service.expiresAt > new Date())) {
      service.subscriptionStatus = "suspended";
    }
    await service.save();
    await this.audit.log({ actorId: actor.id, action: "services.expiry", targetType: "service", targetId: id, sensitive: true });
    return service;
  }

  async suspend(id: string, actor: AuthUser) {
    const service = await this.get(id, actor);
    if (service.subscriptionStatus === "suspended") return service;
    if (service.subscriptionStatus === "expired") throw new BadRequestException("Extend the expiry before suspending or restoring the service");
    // Do not claim suspension until the node confirms the container stopped.
    if (service.containerId && service.status !== "offline" && service.status !== "suspended") {
      const node = await this.nodes.get(service.nodeId.toString());
      await this.nodes.agentCall(node, `/services/${service._id}/stop`);
    }
    service.status = "suspended";
    service.subscriptionStatus = "suspended";
    await service.save();
    await this.audit.log({ actorId: actor.id, action: "services.suspend", targetType: "service", targetId: id, sensitive: true });
    return service;
  }

  async unsuspend(id: string, actor: AuthUser) {
    const service = await this.get(id, actor);
    if (service.expiresAt && service.expiresAt <= new Date()) throw new BadRequestException("Extend the expiry date before unsuspending");
    if (service.subscriptionStatus !== "suspended") throw new BadRequestException("Service is not suspended");
    service.subscriptionStatus = "active";
    service.status = "offline";
    await service.save();
    await this.audit.log({ actorId: actor.id, action: "services.unsuspend", targetType: "service", targetId: id, sensitive: true });
    return service;
  }

  async remove(id: string, actor: AuthUser) {
    const service = await this.get(id, actor);
    // Never remove the database record until the node confirms cleanup.
    const node = await this.nodes.get(service.nodeId.toString());
    await this.nodes.agentCall(node, `/services/${service._id}/delete`);
    await this.services.deleteOne({ _id: service._id });
    await this.audit.log({ actorId: actor.id, action: "services.delete", targetType: "service", targetId: id, sensitive: true });
    return { deleted: true };
  }

  /** Stop expired workloads before marking them expired; retry transient node failures. */
  async expireSweep(): Promise<number> {
    const expired = await this.services.find({ expiresAt: { $lte: new Date() }, subscriptionStatus: "active" }).limit(100);
    let stopped = 0;
    for (const service of expired) {
      try {
        if (service.containerId && service.status !== "offline" && service.status !== "suspended") {
          const node = await this.nodes.get(service.nodeId.toString());
          await this.nodes.agentCall(node, `/services/${service._id}/stop`);
        }
        service.subscriptionStatus = "expired";
        service.status = "suspended";
        await service.save();
        stopped++;
      } catch (error) {
        // Do not falsely report a workload as stopped when its node is unreachable.
        console.error("Could not stop expired service", service._id.toString(), error);
      }
    }
    return stopped;
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
