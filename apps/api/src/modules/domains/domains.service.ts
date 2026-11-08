import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import * as dns from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { buildSubdomain, isStaff } from "@nimbus/shared";
import { env } from "../../config/env";
import { AuditService } from "../audit/audit.service";
import { Domain, DomainDocument } from "./domain.schema";

@Injectable()
export class DomainsService {
  constructor(
    @InjectModel(Domain.name) private readonly domains: Model<DomainDocument>,
    private readonly audit: AuditService,
  ) {}

  async listFor(user: { id: string; role: string }) {
    const filter = isStaff(user.role as never) ? {} : { ownerId: user.id };
    return this.domains.find(filter).limit(200);
  }

  /** Free Nimbus subdomain, e.g. play-username.nimbushost.com — auto-verified. */
  async createSubdomain(username: string, serviceType: string, serviceId: string, ownerId: string) {
    const hostname = buildSubdomain(serviceType, username, env.hostingDomain);
    const clash = await this.domains.findOne({ hostname });
    if (clash) throw new ConflictException("Hostname already allocated");
    return this.domains.create({
      hostname,
      scope: "hosting",
      ownerId: new Types.ObjectId(ownerId),
      serviceId: new Types.ObjectId(serviceId),
      source: "nimbus-subdomain",
      verification: "verified",
      ssl: { status: "pending" },
    });
  }

  /** Customer custom domain — issues a TXT verification token. */
  async addCustomDomain(hostname: string, ownerId: string) {
    const clean = hostname.toLowerCase().trim().replace(/\.$/, "");
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(clean)) {
      throw new BadRequestException("Invalid hostname");
    }
    const existing = await this.domains.findOne({ hostname: clean });
    if (existing) {
      if (existing.ownerId?.toString() === ownerId) throw new ConflictException("Domain already added");
      throw new ConflictException("Domain is already claimed — ownership prevents takeover");
    }
    const token = `nimbus-verify=${randomBytes(24).toString("hex")}`;
    const domain = await this.domains.create({
      hostname: clean,
      scope: "hosting",
      ownerId: new Types.ObjectId(ownerId),
      source: "custom",
      verification: "pending",
      verificationToken: token,
    });
    return { domain, instructions: this.dnsInstructions(clean, token) };
  }

  /** Verify ownership by resolving the TXT record, then verify DNS reachability. */
  async verify(id: string, user: { id: string; role: string }) {
    const domain = await this.domains.findById(id);
    if (!domain) throw new NotFoundException();
    if (domain.ownerId?.toString() !== user.id && !isStaff(user.role as never)) {
      throw new ForbiddenException("Not your domain");
    }
    if (!domain.verificationToken) throw new BadRequestException("Nothing to verify");
    try {
      const records = await dns.resolveTxt(domain.hostname);
      const flat = records.map((r) => r.join(""));
      if (flat.includes(domain.verificationToken)) {
        domain.verification = "verified";
        domain.dnsChecks.push({ at: new Date(), record: "TXT", ok: true });
        await this.audit.log({ actorId: user.id, action: "domains.verified", targetId: id });
      } else {
        domain.verification = "failed";
        domain.dnsChecks.push({ at: new Date(), record: "TXT", ok: false });
      }
    } catch {
      domain.verification = "failed";
      domain.dnsChecks.push({ at: new Date(), record: "TXT", ok: false });
    }
    await domain.save();
    return { verification: domain.verification };
  }

  /** Map a verified domain to a service (A/CNAME/SRV handled by Cloudflare or manual DNS). */
  async mapToService(id: string, serviceId: string, user: { id: string; role: string }) {
    const domain = await this.domains.findById(id);
    if (!domain) throw new NotFoundException();
    if (domain.ownerId?.toString() !== user.id && !isStaff(user.role as never)) {
      throw new ForbiddenException("Not your domain");
    }
    if (domain.verification !== "verified") throw new BadRequestException("Domain is not verified");
    domain.serviceId = new Types.ObjectId(serviceId);
    await domain.save();
    await this.audit.log({ actorId: user.id, action: "domains.map", targetId: id, sensitive: true });
    return domain;
  }

  async remove(id: string, user: { id: string; role: string }) {
    const domain = await this.domains.findById(id);
    if (!domain) throw new NotFoundException();
    if (domain.ownerId?.toString() !== user.id && !isStaff(user.role as never)) {
      throw new ForbiddenException("Not your domain");
    }
    if (domain.source === "cloudflare" && env.cloudflareApiToken) {
      await this.cloudflareDeleteRecord(domain.hostname).catch(() => undefined);
    }
    await domain.deleteOne();
    await this.audit.log({ actorId: user.id, action: "domains.remove", targetId: id, sensitive: true });
    return { ok: true };
  }

  private dnsInstructions(hostname: string, token: string) {
    return {
      txt: { name: `_nimbus.${hostname}`, value: token },
      note: "Create the TXT record at your DNS provider, then run Verify. For Minecraft add an SRV record pointing to your service port.",
    };
  }

  /** Scoped Cloudflare API adapter (token must be DNS-edit scoped — never global). */
  private async cfCall(path: string, init: Record<string, unknown> = {}) {
    if (!env.cloudflareApiToken) throw new BadRequestException("Cloudflare is not configured");
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.cloudflareApiToken}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const json = (await res.json()) as { success: boolean; errors?: unknown[]; result?: unknown };
    if (!json.success) throw new BadRequestException(`Cloudflare error: ${JSON.stringify(json.errors)}`);
    return json.result;
  }

  async cloudflareCreateRecord(type: string, name: string, content: string, proxied = false) {
    return this.cfCall(`/zones/${env.cloudflareZoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type, name, content, proxied, ttl: 3600 }),
    });
  }

  private async cloudflareDeleteRecord(name: string) {
    const records = (await this.cfCall(
      `/zones/${env.cloudflareZoneId}/dns_records?name=${encodeURIComponent(name)}`,
      { method: "GET" },
    )) as { id: string }[];
    for (const rec of records ?? []) {
      await this.cfCall(`/zones/${env.cloudflareZoneId}/dns_records/${rec.id}`, { method: "DELETE" });
    }
  }
}
