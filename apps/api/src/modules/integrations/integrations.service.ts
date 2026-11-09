import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { env } from "../../config/env";
import { IntegrationSetting, IntegrationSettingDocument } from "./integration.schema";

type ServiceAccount = { type?: string; project_id?: string; client_email?: string; private_key?: string };

@Injectable()
export class IntegrationsService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationsService.name);
  private firebaseApp: import("firebase-admin/app").App | null = null;

  constructor(@InjectModel(IntegrationSetting.name) private readonly settings: Model<IntegrationSettingDocument>) {}

  private key(): Buffer {
    return createHash("sha256").update(env.jwtSecret).digest();
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
  }

  private decrypt(value: string): string {
    const [iv, tag, data] = value.split(":");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(data, "hex")), decipher.final()]).toString("utf8");
  }

  async onModuleInit(): Promise<void> {
    const saved = await this.settings.findOne({ key: "firebase-service-account" });
    if (saved) {
      try {
        await this.initialize(JSON.parse(this.decrypt(saved.encryptedValue)) as ServiceAccount);
        this.logger.log("Stored Firebase integration restored");
      } catch (error) {
        this.logger.error("Could not restore saved Firebase integration", (error as Error).message);
      }
    }
  }

  private async initialize(account: ServiceAccount): Promise<void> {
    if (!account.project_id || !account.client_email || !account.private_key || account.type !== "service_account") {
      throw new BadRequestException("Invalid service account JSON. Check that it is a service account key.");
    }
    const appSdk = await import("firebase-admin/app");
    const credential = appSdk.cert(account as never);
    // Verify credentials before saving them.
    await credential.getAccessToken();
    if (this.firebaseApp) await appSdk.deleteApp(this.firebaseApp).catch(() => undefined);
    this.firebaseApp = appSdk.initializeApp(
      { credential, projectId: account.project_id },
      "nimbus-configured-firebase",
    );
  }

  async firebaseStatus() {
    const saved = await this.settings.findOne({ key: "firebase-service-account" }).select("projectId connectedAt").lean();
    return { connected: Boolean(this.firebaseApp && saved), projectId: saved?.projectId ?? null, connectedAt: saved?.connectedAt ?? null };
  }

  async connectFirebase(raw: string, actorId: string) {
    if (typeof raw !== "string" || raw.length > 64_000) throw new BadRequestException("Service account JSON is required (maximum 64 KB).");
    let account: ServiceAccount;
    try { account = JSON.parse(raw) as ServiceAccount; }
    catch { throw new BadRequestException("The supplied credentials are not valid JSON."); }
    await this.initialize(account);
    const encryptedValue = this.encrypt(JSON.stringify(account));
    await this.settings.findOneAndUpdate(
      { key: "firebase-service-account" },
      { $set: { encryptedValue, projectId: account.project_id, connectedAt: new Date(), updatedBy: actorId } },
      { upsert: true, new: true },
    );
    return { connected: true, projectId: account.project_id };
  }

  async disconnectFirebase(actorId: string) {
    if (this.firebaseApp) {
      const appSdk = await import("firebase-admin/app");
      await appSdk.deleteApp(this.firebaseApp).catch(() => undefined);
      this.firebaseApp = null;
    }
    await this.settings.deleteOne({ key: "firebase-service-account" });
    this.logger.warn(`Firebase integration disconnected by admin ${actorId}`);
    return { connected: false };
  }
}
