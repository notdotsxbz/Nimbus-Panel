import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtService } from "@nestjs/jwt";
import { Model, Types } from "mongoose";
import * as bcrypt from "bcryptjs";
import axios from "axios";
import { Agent as HttpsAgent } from "node:https";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";
import { AuditService } from "../audit/audit.service";
import { Node, NodeDocument } from "./node.schema";
import { Service, ServiceDocument } from "../services/service.schema";
import { Allocation, AllocationDocument } from "../allocations/allocation.schema";

/** Per-node credential issued at enrollment — hashed, never stored raw. */
export const hashAgentToken = (token: string) =>
  createHmac("sha256", env.agentSharedSecret).update(token).digest("hex");

export interface NodeDto {
  name: string;
  ip: string;
  sshPort: number;
  sshUsername: string;
  os?: string;
  location?: string;
  cpuCores: number;
  ramTotalMb: number;
  diskTotalGb: number;
}

@Injectable()
export class NodesService {
  constructor(
    @InjectModel(Node.name) private readonly nodes: Model<NodeDocument>,
    @InjectModel(Service.name) private readonly services: Model<ServiceDocument>,
    @InjectModel(Allocation.name) private readonly allocations: Model<AllocationDocument>,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return this.nodes.find({ status: { $ne: "retired" } }).sort({ name: 1 });
  }

  async get(id: string) {
    const node = await this.nodes.findById(id);
    if (!node) throw new NotFoundException("Node not found");
    return node;
  }

  /** Admin edit of node metadata/capacity. Registration identity is immutable. */
  async updateNode(id: string, dto: Partial<NodeDto>, actorId: string) {
    const node = await this.get(id);
    const editable = ["name", "ip", "sshPort", "sshUsername", "os", "location", "cpuCores", "ramTotalMb", "diskTotalGb"] as const;
    for (const key of editable) {
      if (dto[key] !== undefined) (node as unknown as Record<string, unknown>)[key] = dto[key];
    }
    if (dto.ip && dto.ip !== node.ip) node.agentUrl = `https://${dto.ip}:7443`;
    await node.save();
    await this.audit.log({ actorId, action: "nodes.update", targetType: "node", targetId: id, sensitive: true });
    return node;
  }

  /**
   * Refresh Health: returns the cached heartbeat plus staleness. Heartbeats
   * are pushed by the agent every 15 s; if none arrived within 60 s the node
   * is marked offline. Never fabricates telemetry.
   */
  async refreshHealth(id: string) {
    const node = await this.get(id);
    const staleMs = node.lastHeartbeatAt ? Date.now() - node.lastHeartbeatAt.getTime() : Infinity;
    if (staleMs > 60_000 && node.online) {
      node.online = false;
      await node.save();
    }
    return {
      nodeId: id,
      online: node.online,
      maintenanceMode: node.maintenanceMode,
      lastHeartbeat: node.lastHeartbeat ?? null,
      lastHeartbeatAt: node.lastHeartbeatAt ?? null,
      heartbeatAgeSeconds: Number.isFinite(staleMs) ? Math.round(staleMs / 1000) : null,
      note: Number.isFinite(staleMs) && staleMs > 60_000
        ? "Heartbeat is stale — the agent may be down or unreachable."
        : "Heartbeat is fresh.",
    };
  }

  /** Services (workloads) placed on this node. */
  async workloads(id: string) {
    await this.get(id);
    return this.services.find({ nodeId: new Types.ObjectId(id) }, "name type status cpuPercent ramMb diskGb expiresAt");
  }

  /** Port/IP allocations belonging to this node. */
  async listAllocations(id: string) {
    await this.get(id);
    return this.allocations.find({ nodeId: new Types.ObjectId(id) }).populate("serviceId", "name type");
  }

  /**
   * Revoke Credentials: clears the node's agent credential and returns to
   * enrolling state with a fresh single-use enrollment token. The running
   * agent loses API access immediately (its token no longer validates).
   */
  async revokeCredentials(id: string, actorId: string) {
    const node = await this.get(id);
    node.agentTokenHash = undefined;
    node.status = "enrolling";
    node.online = false;
    await node.save();
    const enrollmentToken = await this.issueEnrollmentToken(node);
    await this.audit.log({
      actorId, action: "nodes.credentials.revoke", targetType: "node", targetId: id, sensitive: true,
    });
    return { revoked: true, enrollmentToken, note: "The running agent is locked out until it re-enrolls with the new token." };
  }

  /**
   * Delete Node — SAFE mode. Refuses while any service (workload) or
   * in-use allocation references the node. Removes only the Control-Plane
   * registration and revokes credentials; the remote machine, its software
   * and all customer data are untouched.
   */
  async removeNode(id: string, mode: "safe" | "force", actor: { id: string; role: string }, confirmName?: string, password?: string) {
    const node = await this.get(id);
    if (node.status === "retired") throw new BadRequestException("Node is already deleted");

    const services = await this.services.find({ nodeId: node._id }, "name type status");
    const inUseAllocations = await this.allocations.countDocuments({ nodeId: node._id, serviceId: { $ne: null } });

    if (mode === "safe") {
      if (services.length > 0 || inUseAllocations > 0) {
        throw new BadRequestException({
          message: "Safe Delete requires an empty node — migrate or remove its workloads first.",
          workloads: services.map((s) => ({ id: s._id, name: s.name, type: s.type, status: s.status })),
          allocationsInUse: inUseAllocations,
        });
      }
    } else {
      // FORCE: Owner-only, re-authentication + exact node name required.
      if (actor.role !== "owner") {
        throw new ForbiddenException("Force Delete is restricted to the Owner role");
      }
      if (confirmName !== node.name) {
        throw new BadRequestException("Confirmation failed — type the exact node name");
      }
      const actorDoc = await this.nodes.db.collection("users").findOne({ _id: new Types.ObjectId(actor.id) });
      const hash = (actorDoc?.passwordHash as string | undefined) ?? "";
      if (!password || !hash || !(await bcrypt.compare(password, hash))) {
        throw new ForbiddenException("Re-authentication failed — enter your own account password");
      }
    }

    // Control-plane teardown (never touches the remote machine):
    if (mode === "force") {
      // Orphaned workloads are marked suspended so nothing claims a ghost node.
      await this.services.updateMany(
        { nodeId: node._id },
        {
          $set: { status: "suspended", subscriptionStatus: "suspended" },
          $push: { activity: { at: new Date(), action: "node.forceDeleted", ok: false, detail: `Node ${node.name} was force-deleted; migrate this service.` } },
        },
      );
      // Allocations are control-plane records bound to this node — removed
      // with the node in force mode (displayed in the dialog beforehand).
      await this.allocations.deleteMany({ nodeId: node._id });
    }
    node.status = "retired";
    node.online = false;
    node.agentTokenHash = undefined; // revoke credentials permanently
    await node.save();
    await this.audit.log({
      actorId: actor.id,
      action: `nodes.delete.${mode}`,
      targetType: "node",
      targetId: id,
      detail: `node=${node.name} ip=${node.ip} workloads=${services.length} allocationsInUse=${inUseAllocations}`,
      sensitive: true,
    });
    return {
      deleted: true,
      mode,
      node: { id, name: node.name, ip: node.ip },
      affectedWorkloads: mode === "force" ? services.map((s) => s.name) : [],
      note:
        "Control-plane registration removed and credentials revoked. The remote machine, its software, backups and customer data were NOT modified." +
        (node.online ? "" : " WARNING: the node was unreachable — remote cleanup could not be verified."),
    };
  }

  async create(dto: NodeDto, actorId: string) {
    const node = await this.nodes.create({
      ...dto,
      agentUrl: `https://${dto.ip}:7443`,
      status: "enrolling",
    });
    const enrollmentToken = await this.issueEnrollmentToken(node);
    await this.audit.log({
      actorId,
      action: "nodes.create",
      targetType: "node",
      targetId: node._id!.toString(),
      sensitive: true,
    });
    return { node, enrollmentToken };
  }

  /** Single-use, short-lived enrollment token signed with the shared secret. */
  async issueEnrollmentToken(node: NodeDocument): Promise<string> {
    return this.jwt.sign(
      { nid: node._id!.toString(), jti: randomBytes(16).toString("hex") },
      {
        secret: env.agentSharedSecret,
        expiresIn: `${env.enrollmentTokenTtlMinutes}m`,
      },
    );
  }

  /** Agent completes enrollment and receives its permanent node credential. */
  async completeEnrollment(nodeId: string, jti: string): Promise<string> {
    const node = await this.nodes.findById(nodeId);
    if (!node) throw new NotFoundException("Unknown node");
    if (node.status !== "enrolling") throw new BadRequestException("Enrollment already completed");
    const agentToken = randomBytes(32).toString("hex");
    node.status = "active";
    node.online = true;
    node.lastHeartbeatAt = new Date();
    node.agentTokenHash = hashAgentToken(agentToken);
    await node.save();
    await this.audit.log({ action: "nodes.enrolled", targetType: "node", targetId: nodeId });
    return agentToken;
  }

  /** Heartbeat authentication: agent token checked against stored hash. */
  async authenticateAgent(nodeId: string, token: string): Promise<NodeDocument> {
    if (!/^[a-f\d]{24}$/i.test(nodeId)) throw new NotFoundException("Unknown node");
    const node = await this.nodes.findById(nodeId).select("+agentTokenHash");
    if (!node?.agentTokenHash || node.status === "retired") throw new NotFoundException("Unknown node");
    const expected = Buffer.from(node.agentTokenHash, "hex");
    const provided = Buffer.from(hashAgentToken(token), "hex");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new BadRequestException("Invalid agent credential");
    }
    return node;
  }

  async heartbeat(
    node: NodeDocument,
    hb: {
      cpuPercent: number;
      ramUsedBytes: number;
      ramTotalBytes: number;
      diskUsedBytes: number;
      diskTotalBytes: number;
      containersRunning: number;
      uptimeSeconds: number;
      agentVersion: string;
    },
  ) {
    node.online = true;
    node.lastHeartbeatAt = new Date();
    node.lastHeartbeat = { nodeId: node._id!.toString(), at: new Date().toISOString(), ...hb };
    await node.save();
    return { ok: true, maintenanceMode: node.maintenanceMode };
  }

  async setMaintenance(id: string, mode: boolean, actorId: string) {
    const node = await this.nodes.findByIdAndUpdate(
      id,
      { maintenanceMode: mode, status: mode ? "maintenance" : "active" },
      { new: true },
    );
    await this.audit.log({
      actorId,
      action: mode ? "nodes.maintenance.enable" : "nodes.maintenance.disable",
      targetType: "node",
      targetId: id,
      sensitive: true,
    });
    return node;
  }

  /** Nodes with real capacity for a requested footprint — never overcommits. */
  async findCapacity(ramMb: number, diskGb: number) {
    const nodes = await this.nodes.find({ online: true, status: "active", maintenanceMode: false });
    const services = await this.services.find({}, "ramMb diskGb nodeId");
    const usage = new Map<string, { ram: number; disk: number }>();
    for (const s of services as { nodeId: { toString(): string }; ramMb: number; diskGb: number }[]) {
      const key = s.nodeId.toString();
      const cur = usage.get(key) ?? { ram: 0, disk: 0 };
      cur.ram += s.ramMb;
      cur.disk += s.diskGb;
      usage.set(key, cur);
    }
    return nodes
      .filter((n) => {
        const used = usage.get(n._id!.toString()) ?? { ram: 0, disk: 0 };
        return n.ramTotalMb - used.ram >= ramMb && n.diskTotalGb - used.disk >= diskGb;
      })
      .map((n) => {
        const used = usage.get(n._id!.toString()) ?? { ram: 0, disk: 0 };
        return {
          nodeId: n._id!.toString(),
          ramAllocatedMb: used.ram,
          ramTotalMb: n.ramTotalMb,
          diskAllocatedGb: used.disk,
          diskTotalGb: n.diskTotalGb,
          healthy: n.online && !n.maintenanceMode,
        };
      });
  }

  /** Authenticated command to a node agent (never the control plane shell). */
  async agentCall(node: NodeDocument, path: string, body?: unknown, method: "GET" | "POST" = "POST") {
    const token = this.jwt.sign({ nid: node._id!.toString() }, { secret: env.agentSharedSecret, expiresIn: "2m" });
    const res = await axios({
      method,
      url: `${node.agentUrl}${path}`,
      data: body,
      headers: { authorization: `Bearer ${token}`, "x-nimbus-node": node._id!.toString() },
      timeout: 15_000,
      // Agents use self-signed certificates scoped to their own IP
      httpsAgent: new HttpsAgent({ rejectUnauthorized: false }),
    });
    return res.data;
  }

  /** Download a completed archive from the authenticated node agent. */
  async downloadBackupArchive(node: NodeDocument, serviceId: string, backupId: string): Promise<Buffer> {
    const token = this.jwt.sign({ nid: node._id!.toString() }, { secret: env.agentSharedSecret, expiresIn: "2m" });
    const response = await axios({
      method: "POST",
      url: `${node.agentUrl}/backups/download`,
      data: { serviceId, backupId },
      headers: { authorization: `Bearer ${token}`, "x-nimbus-node": node._id!.toString() },
      timeout: 10 * 60 * 1000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      responseType: "arraybuffer",
      httpsAgent: new HttpsAgent({ rejectUnauthorized: false }),
    });
    return Buffer.from(response.data);
  }

  async markOffline(id: string) {
    await this.nodes.updateOne({ _id: id }, { online: false });
  }
}
