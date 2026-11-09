import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { env } from "../../config/env";
import { IntegrationSetting, IntegrationSettingDocument } from "./integration.schema";

type ServiceAccount = { type?: string; project_id?: string; client_email?: string; private_key?: string };
type FirebaseWebConfig = { apiKey: string; authDomain: string; projectId: string; appId: string; storageBucket?: string; messagingSenderId?: string };

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
    const web = await this.settings.findOne({ key: "firebase-web-config" }).select("projectId").lean();
    return { connected: Boolean(this.firebaseApp && saved), projectId: saved?.projectId ?? null, webConfigured: Boolean(web), connectedAt: saved?.connectedAt ?? null };
  }

  async publicFirebaseConfig(): Promise<FirebaseWebConfig> {
    const saved = await this.settings.findOne({ key: "firebase-web-config" });
    if (!saved) throw new BadRequestException("Firebase web configuration is not connected");
    return JSON.parse(this.decrypt(saved.encryptedValue)) as FirebaseWebConfig;
  }

  async verifyIdToken(idToken: string): Promise<{ uid: string; email?: string; name?: string }> {
    if (!this.firebaseApp) throw new BadRequestException("Firebase Admin is not configured");
    const auth = await import("firebase-admin/auth");
    const decoded = await auth.getAuth(this.firebaseApp).verifyIdToken(idToken, true);
    return { uid: decoded.uid, email: decoded.email, name: decoded.name };
  }

  async createFirebaseAuthUser(email: string, password: string, displayName?: string) {
    if (!this.firebaseApp) throw new BadRequestException("Connect Firebase in Settings first");
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
      throw new BadRequestException("A valid email and password of at least 8 characters are required");
    }
    const auth = await import("firebase-admin/auth");
    const user = await auth.getAuth(this.firebaseApp).createUser({ email: email.toLowerCase().trim(), password, displayName, emailVerified: false, disabled: false });
    return { uid: user.uid, email: user.email };
  }

  async updateFirebaseAuthUserPassword(uid: string, password: string) {
    if (!this.firebaseApp) throw new BadRequestException("Connect Firebase in Settings first");
    if (password.length < 8) throw new BadRequestException("Password must be at least 8 characters");
    const auth = await import("firebase-admin/auth");
    await auth.getAuth(this.firebaseApp).updateUser(uid, { password });
  }

  async deleteFirebaseAuthUser(uid: string) {
    if (!this.firebaseApp) return;
    const auth = await import("firebase-admin/auth");
    await auth.getAuth(this.firebaseApp).deleteUser(uid).catch(() => undefined);
  }

  async connectFirebase(raw: string, actorId: string, webConfig?: FirebaseWebConfig) {
    if (typeof raw !== "string" || raw.length > 64_000) throw new BadRequestException("Service account JSON is required (maximum 64 KB).");
    let account: ServiceAccount;
    try { account = JSON.parse(raw) as ServiceAccount; }
    catch { throw new BadRequestException("The supplied credentials are not valid JSON."); }
    await this.initialize(account);
    const encryptedValue = this.encrypt(JSON.stringify(account));
    if (webConfig) {
      if (!webConfig.apiKey || !webConfig.authDomain || !webConfig.projectId || !webConfig.appId || webConfig.projectId !== account.project_id) {
        throw new BadRequestException("Firebase Web App settings must be complete and match the service-account project");
      }
      await this.settings.findOneAndUpdate(
        { key: "firebase-web-config" },
        { $set: { encryptedValue: this.encrypt(JSON.stringify(webConfig)), projectId: webConfig.projectId, connectedAt: new Date(), updatedBy: actorId } },
        { upsert: true, new: true },
      );
    }
    await this.settings.findOneAndUpdate(
      { key: "firebase-service-account" },
      { $set: { encryptedValue, projectId: account.project_id, connectedAt: new Date(), updatedBy: actorId } },
      { upsert: true, new: true },
    );
    return { connected: true, projectId: account.project_id };
  }

  async cloudflareStatus() {
    const saved = await this.settings.findOne({ key: "cloudflare" }).select("projectId connectedAt").lean();
    return { connected: Boolean(saved), zoneId: saved?.projectId ?? null, connectedAt: saved?.connectedAt ?? null };
  }

  async connectCloudflare(token: string, zoneId: string, actorId: string) {
    if (!token || !zoneId || token.length > 4096 || zoneId.length > 128) throw new BadRequestException("Cloudflare API token and Zone ID are required");
    const response = await fetch("https://api.cloudflare.com/client/v4/zones/" + encodeURIComponent(zoneId), {
      headers: { authorization: "Bearer " + token },
    });
    const result = await response.json() as { success?: boolean; result?: { id?: string; name?: string }; errors?: Array<{ message?: string }> };
    if (!response.ok || !result.success || result.result?.id !== zoneId) throw new BadRequestException(result.errors?.[0]?.message ?? "Cloudflare token could not access this Zone");
    await this.settings.findOneAndUpdate(
      { key: "cloudflare" },
      { $set: { encryptedValue: this.encrypt(JSON.stringify({ token, zoneId })), projectId: zoneId, connectedAt: new Date(), updatedBy: actorId } },
      { upsert: true, new: true },
    );
    return { connected: true, zoneId, zoneName: result.result.name ?? null };
  }

  async cloudflareCredentials(): Promise<{ token: string; zoneId: string } | null> {
    const saved = await this.settings.findOne({ key: "cloudflare" });
    if (!saved) return null;
    return JSON.parse(this.decrypt(saved.encryptedValue)) as { token: string; zoneId: string };
  }

  async googleDriveStatus() {
    const saved = await this.settings.findOne({ key: "google-drive" }).select("connectedAt").lean();
    return { connected: Boolean(saved), connectedAt: saved?.connectedAt ?? null };
  }

  async beginGoogleDriveConnect(clientId: string, clientSecret: string, actorId: string) {
    if (!clientId || !clientSecret || clientId.length > 512 || clientSecret.length > 1024) {
      throw new BadRequestException("Google OAuth Client ID and Client Secret are required");
    }
    const redirectUri = env.webUrl.replace(/\/$/, "") + "/admin/settings";
    await this.settings.findOneAndUpdate(
      { key: "google-oauth-config" },
      { $set: { encryptedValue: this.encrypt(JSON.stringify({ clientId, clientSecret, redirectUri })), connectedAt: new Date(), updatedBy: actorId } },
      { upsert: true, new: true },
    );
    const state = randomBytes(24).toString("hex");
    await this.settings.create({ key: "google-oauth-state:" + state, encryptedValue: this.encrypt(JSON.stringify({ actorId })), connectedAt: new Date() });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return { url: "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString() };
  }

  async exchangeGoogleDriveCode(code: string, state: string) {
    if (!code || !state || !/^[a-f0-9]{48}$/.test(state)) throw new BadRequestException("Invalid Google OAuth callback");
    const pendingKey = "google-oauth-state:" + state;
    const pending = await this.settings.findOne({ key: pendingKey });
    if (!pending || !pending.connectedAt || Date.now() - pending.connectedAt.getTime() > 10 * 60 * 1000) {
      throw new BadRequestException("Google connection request expired. Start again from Settings.");
    }
    await this.settings.deleteOne({ key: pendingKey });
    const configDoc = await this.settings.findOne({ key: "google-oauth-config" });
    if (!configDoc) throw new BadRequestException("Google OAuth settings are missing");
    const config = JSON.parse(this.decrypt(configDoc.encryptedValue)) as { clientId: string; clientSecret: string; redirectUri: string };
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokens = await response.json() as { refresh_token?: string; access_token?: string; error_description?: string };
    if (!response.ok || !tokens.refresh_token) {
      throw new BadRequestException(tokens.error_description ?? "Google did not return a refresh token. Reconnect and approve access.");
    }
    await this.settings.findOneAndUpdate(
      { key: "google-drive" },
      { $set: { encryptedValue: this.encrypt(JSON.stringify({ refreshToken: tokens.refresh_token })), connectedAt: new Date(), updatedBy: "google-oauth" } },
      { upsert: true, new: true },
    );
    return { connected: true };
  }

  async googleDriveAccessToken(): Promise<string> {
    const [tokenDoc, configDoc] = await Promise.all([
      this.settings.findOne({ key: "google-drive" }),
      this.settings.findOne({ key: "google-oauth-config" }),
    ]);
    if (!tokenDoc || !configDoc) throw new BadRequestException("Connect Google Drive in Settings first");
    const token = JSON.parse(this.decrypt(tokenDoc.encryptedValue)) as { refreshToken: string };
    const config = JSON.parse(this.decrypt(configDoc.encryptedValue)) as { clientId: string; clientSecret: string };
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: token.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const result = await response.json() as { access_token?: string; error_description?: string };
    if (!response.ok || !result.access_token) throw new BadRequestException(result.error_description ?? "Could not refresh Google Drive access");
    return result.access_token;
  }

  async disconnectGoogleDrive(actorId: string) {
    await this.settings.deleteMany({ key: { $in: ["google-drive", "google-oauth-config"] } });
    await this.settings.deleteMany({ key: { $regex: "^google-oauth-state:" } });
    this.logger.warn("Google Drive disconnected by " + actorId);
    return { connected: false };
  }

  async disconnectCloudflare(actorId: string) {
    await this.settings.deleteOne({ key: "cloudflare" });
    this.logger.warn("Cloudflare integration disconnected by " + actorId);
    return { connected: false };
  }

  async disconnectFirebase(actorId: string) {
    if (this.firebaseApp) {
      const appSdk = await import("firebase-admin/app");
      await appSdk.deleteApp(this.firebaseApp).catch(() => undefined);
      this.firebaseApp = null;
    }
    await this.settings.deleteMany({ key: { $in: ["firebase-service-account", "firebase-web-config"] } });
    this.logger.warn(`Firebase integration disconnected by admin ${actorId}`);
    return { connected: false };
  }
}
