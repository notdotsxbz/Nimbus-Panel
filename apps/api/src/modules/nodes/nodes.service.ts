import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtService } from "@nestjs/jwt";
import { Model } from "mongoose";
import axios from "axios";
import { Agent as HttpsAgent } from "node:https";
import { env } from "../../config/env";
import { AuditService } from "../audit/audit.service";
import { Node, NodeDocument } from "./node.schema";
import { Service, ServiceDocument } from "../services/service.schema";

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
    // Single-use: the jti must not be replayed (checked via status transition).
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
    // agentTokenHash is select:false — it must be explicitly included here.
    const node = await this.nodes.findById(nodeId).select("+agentTokenHash");
    if (!node?.agentTokenHash) throw new NotFoundException("Unknown node");
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
      headers: { authorization: `Bearer ${token}` },
      timeout: 15_000,
      // Agents use self-signed certificates scoped to their own IP
      httpsAgent: new HttpsAgent({ rejectUnauthorized: false }),
    });
    return res.data;
  }

  async markOffline(id: string) {
    await this.nodes.updateOne({ _id: id }, { online: false });
  }
}
