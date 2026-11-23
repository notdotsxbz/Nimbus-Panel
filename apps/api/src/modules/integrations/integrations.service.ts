import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { env } from "../../config/env";
import { IntegrationSetting, IntegrationSettingDocument } from "./integration.schema";

type ServiceAccount = { type?: string; project_id?: string; client_email?: string; private_key?: string };
type FirebaseWebConfig = { apiKey: string; authDomain: string; projectId: string; appId: string; storageBucket?: string; messagingSenderId?: string; googleClientId?: string };

@Injectable()
export class IntegrationsService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationsService.name);
  private firebaseApp: import("firebase-admin/app").App | null = null;

  constructor(@InjectModel(IntegrationSetting.name) private readonly settings: Model<IntegrationSettingDocument>) {}

  private key(): Buffer {
    return createHash("sha256").update(env.integrationEncryptionKey).digest();
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

  private googleDriveConnectionKey(ownerType: "admin" | "customer", ownerId?: string): string {
    if (ownerType === "admin") return "google-drive:admin";
    if (!ownerId) throw new BadRequestException("Customer account is required for a personal Google Drive connection");
    return "google-drive:customer:" + ownerId;
  }

  async googleDriveStatus(ownerType: "admin" | "customer" = "admin", ownerId?: string) {
    const key = this.googleDriveConnectionKey(ownerType, ownerId);
    let saved = await this.settings.findOne({ key }).select("connectedAt accountEmail folderId").lean();
    // Backward-compatible adoption of the former single shared connection as
    // the Admin Drive only. Customer connections are never derived from it.
    if (!saved && ownerType === "admin") {
      const legacy = await this.settings.findOne({ key: "google-drive" });
      if (legacy) {
        await this.settings.findOneAndUpdate(
          { key },
          { $setOnInsert: { encryptedValue: legacy.encryptedValue, connectedAt: legacy.connectedAt, updatedBy: legacy.updatedBy } },
          { upsert: true },
        );
        saved = await this.settings.findOne({ key }).select("connectedAt accountEmail folderId").lean();
      }
    }
    const config = await this.settings.findOne({ key: "google-oauth-config" }).select("_id").lean();
    if (!saved || !config) return { connected: false, connectedAt: null, accountEmail: null };
    try {
      await this.googleDriveAccessToken(ownerType, ownerId);
      return { connected: true, connectedAt: saved.connectedAt ?? null, accountEmail: saved.accountEmail ?? null, folderId: saved.folderId ?? null };
    } catch {
      return { connected: false, connectedAt: saved.connectedAt ?? null, accountEmail: saved.accountEmail ?? null, reconnectRequired: true };
    }
  }

  async beginGoogleDriveConnect(clientId: string, clientSecret: string, actorId: string, origin?: string) {
    if (!clientId || !clientSecret || clientId.length > 512 || clientSecret.length > 1024) {
      throw new BadRequestException("Google OAuth Client ID and Client Secret are required");
    }
    await this.settings.findOneAndUpdate(
      { key: "google-oauth-config" },
      { $set: { encryptedValue: this.encrypt(JSON.stringify({ clientId, clientSecret })), connectedAt: new Date(), updatedBy: actorId } },
      { upsert: true, new: true },
    );
    return this.beginGoogleDriveOAuth("admin", undefined, actorId, origin);
  }

  async beginCustomerGoogleDriveConnect(actorId: string, origin?: string) {
    const config = await this.settings.findOne({ key: "google-oauth-config" });
    if (!config) throw new BadRequestException("The panel administrator must configure Google OAuth before customers can connect Drive");
    return this.beginGoogleDriveOAuth("customer", actorId, actorId, origin);
  }

  private async beginGoogleDriveOAuth(ownerType: "admin" | "customer", ownerId: string | undefined, actorId: string, origin?: string) {
    const configDoc = await this.settings.findOne({ key: "google-oauth-config" });
    if (!configDoc) throw new BadRequestException("Google OAuth settings are missing");
    const config = JSON.parse(this.decrypt(configDoc.encryptedValue)) as { clientId: string; clientSecret: string };
    let panelOrigin: URL;
    try { panelOrigin = new URL(origin || env.webUrl); }
    catch { throw new BadRequestException("Could not determine the panel URL for Google OAuth"); }
    if (panelOrigin.protocol !== "https:" && !(panelOrigin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(panelOrigin.hostname))) {
      throw new BadRequestException("Google Drive OAuth must use the HTTPS panel domain");
    }
    if (panelOrigin.pathname !== "/" || panelOrigin.search || panelOrigin.hash || panelOrigin.username || panelOrigin.password) {
      throw new BadRequestException("Invalid panel origin for Google OAuth");
    }
    const redirectUri = panelOrigin.origin + (ownerType === "admin" ? "/admin/settings" : "/account");
    const state = randomBytes(24).toString("hex");
    await this.settings.create({
      key: "google-oauth-state:" + state,
      encryptedValue: this.encrypt(JSON.stringify({ actorId, ownerType, ownerId, redirectUri })),
      connectedAt: new Date(),
    });
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return { url: "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString() };
  }

  private async findOrCreateDriveFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
    const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const clauses = [
      `name = '${escapedName}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
    ];
    if (parentId) clauses.push(`'${parentId}' in parents`);
    const query = new URLSearchParams({ q: clauses.join(" and "), pageSize: "1", fields: "files(id,name)" });
    const listed = await fetch("https://www.googleapis.com/drive/v3/files?" + query.toString(), {
      headers: { authorization: "Bearer " + accessToken },
    });
    const listData = await listed.json() as { files?: Array<{ id?: string }> ; error?: { message?: string } };
    if (!listed.ok) throw new BadRequestException(listData.error?.message ?? "Could not inspect the Google Drive backup folders");
    if (listData.files?.[0]?.id) return listData.files[0].id;
    const created = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
      method: "POST",
      headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    const folder = await created.json() as { id?: string; error?: { message?: string } };
    if (!created.ok || !folder.id) throw new BadRequestException(folder.error?.message ?? "Could not create a Google Drive backup folder");
    return folder.id;
  }

  private async ensureDriveRootFolder(accessToken: string, ownerType: "admin" | "customer", existingFolderId?: string): Promise<string> {
    const rootName = ownerType === "admin" ? "NIMBUS Full Panel Backups" : "NIMBUS Backups";
    const rootId = existingFolderId || await this.findOrCreateDriveFolder(accessToken, rootName);
    if (ownerType === "customer") {
      const categories = ["Minecraft", "Discord Bots", "Websites", "Backends", "Node.js", "Python", "MongoDB", "Databases", "Docker", "Lavalink", "Custom Applications", "VPS", "VDS"];
      for (const category of categories) await this.findOrCreateDriveFolder(accessToken, category, rootId);
    } else {
      const panel = await this.findOrCreateDriveFolder(accessToken, "Panel", rootId);
      for (const name of ["Database", "Configuration", "System Metadata", "Backup Manifest"]) {
        await this.findOrCreateDriveFolder(accessToken, name, panel);
      }
      await this.findOrCreateDriveFolder(accessToken, "Users", rootId);
      await this.findOrCreateDriveFolder(accessToken, "Full Backup Manifests", rootId);
    }
    return rootId;
  }

  async googleDriveAdminPanelFolder(section: "Database" | "Configuration" | "System Metadata" | "Backup Manifest" | "Full Backup Manifests"): Promise<string> {
    const key = this.googleDriveConnectionKey("admin");
    let connection = await this.settings.findOne({ key });
    if (!connection) {
      const legacy = await this.settings.findOne({ key: "google-drive" });
      if (legacy) {
        connection = await this.settings.findOneAndUpdate(
          { key },
          { $setOnInsert: { encryptedValue: legacy.encryptedValue, connectedAt: legacy.connectedAt, updatedBy: legacy.updatedBy } },
          { upsert: true, new: true },
        );
      }
    }
    if (!connection) throw new BadRequestException("Connect the Admin Google Drive before creating a full panel backup");
    const accessToken = await this.googleDriveAccessToken("admin");
    const rootId = connection.folderId || await this.ensureDriveRootFolder(accessToken, "admin");
    if (!connection.folderId) await this.settings.updateOne({ key }, { $set: { folderId: rootId } });
    if (section === "Full Backup Manifests") return this.findOrCreateDriveFolder(accessToken, section, rootId);
    const panelId = await this.findOrCreateDriveFolder(accessToken, "Panel", rootId);
    return this.findOrCreateDriveFolder(accessToken, section, panelId);
  }

  async googleDriveBackupFolder(
    ownerType: "admin" | "customer",
    ownerId: string | undefined,
    serviceType: string,
    serviceName: string,
    customerFolderName?: string,
  ): Promise<string> {
    const key = this.googleDriveConnectionKey(ownerType, ownerId);
    let connection = await this.settings.findOne({ key });
    if (!connection && ownerType === "admin") {
      const legacy = await this.settings.findOne({ key: "google-drive" });
      if (legacy) {
        connection = await this.settings.findOneAndUpdate(
          { key },
          { $setOnInsert: { encryptedValue: legacy.encryptedValue, connectedAt: legacy.connectedAt, updatedBy: legacy.updatedBy } },
          { upsert: true, new: true },
        );
      }
    }
    if (!connection) throw new BadRequestException("Connect your Google Drive before creating backups");
    const accessToken = await this.googleDriveAccessToken(ownerType, ownerId);
    const rootId = connection.folderId || await this.ensureDriveRootFolder(accessToken, ownerType);
    if (!connection.folderId) await this.settings.updateOne({ key }, { $set: { folderId: rootId } });
    const categories: Record<string, string> = {
      minecraft: "Minecraft", discord: "Discord Bots", "discord-bot": "Discord Bots",
      website: "Websites", backend: "Backends", nodejs: "Node.js", python: "Python",
      mongodb: "MongoDB", database: "Databases", docker: "Docker", lavalink: "Lavalink",
      custom: "Custom Applications", vps: "VPS", vds: "VDS",
    };
    const categoryName = categories[serviceType.toLowerCase()] ?? serviceType.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    let categoryParentId = rootId;
    if (ownerType === "admin") {
      const usersFolderId = await this.findOrCreateDriveFolder(accessToken, "Users", rootId);
      const safeCustomerName = (customerFolderName || "customer").replace(/[^a-zA-Z0-9._ -]/g, "-").trim().slice(0, 70) || "customer";
      const customerFolderId = await this.findOrCreateDriveFolder(accessToken, safeCustomerName + "_" + (ownerId || "unknown"), usersFolderId);
      categoryParentId = customerFolderId;
    }
    const categoryId = await this.findOrCreateDriveFolder(accessToken, categoryName, categoryParentId);
    const safeServiceName = serviceName.replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9._ -]/g, "-").trim().slice(0, 100) || "Unnamed Service";
    return this.findOrCreateDriveFolder(accessToken, safeServiceName, categoryId);
  }

  async exchangeGoogleDriveCode(code: string, state: string, actorId: string) {
    if (!code || !state || !/^[a-f0-9]{48}$/.test(state)) throw new BadRequestException("Invalid Google OAuth callback");
    const pendingKey = "google-oauth-state:" + state;
    const pending = await this.settings.findOne({ key: pendingKey });
    if (!pending || !pending.connectedAt || Date.now() - pending.connectedAt.getTime() > 10 * 60 * 1000) {
      throw new BadRequestException("Google connection request expired. Start again from Settings.");
    }
    const pendingData = JSON.parse(this.decrypt(pending.encryptedValue)) as { actorId: string; ownerType?: "admin" | "customer"; ownerId?: string; redirectUri: string };
    if (pendingData.actorId !== actorId) throw new BadRequestException("Google OAuth state belongs to a different signed-in account");
    await this.settings.deleteOne({ key: pendingKey });
    const configDoc = await this.settings.findOne({ key: "google-oauth-config" });
    if (!configDoc) throw new BadRequestException("Google OAuth settings are missing");
    const config = JSON.parse(this.decrypt(configDoc.encryptedValue)) as { clientId: string; clientSecret: string };
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: pendingData.redirectUri,
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokens = await response.json() as { refresh_token?: string; access_token?: string; error_description?: string; error?: string };
    if (!response.ok || !tokens.access_token) {
      throw new BadRequestException(tokens.error_description ?? tokens.error ?? "Google rejected the OAuth authorization code");
    }
    const ownerType = pendingData.ownerType ?? "admin";
    const ownerId = pendingData.ownerId;
    const key = this.googleDriveConnectionKey(ownerType, ownerId);
    const previous = await this.settings.findOne({ key });
    const previousToken = previous ? (JSON.parse(this.decrypt(previous.encryptedValue)) as { refreshToken?: string }).refreshToken : undefined;
    const refreshToken = tokens.refresh_token ?? previousToken;
    if (!refreshToken) {
      throw new BadRequestException("Google did not provide a refresh token. Remove Nimbus from your Google Account connections, then reconnect and approve Drive access.");
    }
    let accountEmail: string | undefined;
    try {
      const profile = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: "Bearer " + tokens.access_token } });
      if (profile.ok) {
        const data = await profile.json() as { email?: string };
        accountEmail = data.email;
      }
    } catch { /* Drive connection remains valid if profile lookup is temporarily unavailable. */ }
    const savedConnection = await this.settings.findOneAndUpdate(
      { key },
      { $set: { encryptedValue: this.encrypt(JSON.stringify({ refreshToken })), connectedAt: new Date(), updatedBy: actorId, ...(accountEmail ? { accountEmail } : {}) } },
      { upsert: true, new: true },
    );
    try {
      const folderId = await this.ensureDriveRootFolder(tokens.access_token, ownerType, savedConnection.folderId);
      await this.settings.updateOne({ key }, { $set: { folderId } });
    } catch (error) {
      this.logger.error("Google Drive connected, but automatic backup folder setup failed", (error as Error).message);
    }
    return { connected: true, ownerType };
  }

  async googleDriveAccessToken(ownerType: "admin" | "customer" = "admin", ownerId?: string): Promise<string> {
    const key = this.googleDriveConnectionKey(ownerType, ownerId);
    let tokenDoc = await this.settings.findOne({ key });
    if (!tokenDoc && ownerType === "admin") tokenDoc = await this.settings.findOne({ key: "google-drive" });
    const configDoc = await this.settings.findOne({ key: "google-oauth-config" });
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
    const result = await response.json() as { access_token?: string; error_description?: string; error?: string };
    if (!response.ok || !result.access_token) throw new BadRequestException(result.error_description ?? result.error ?? "Could not refresh Google Drive access. Reconnect Google Drive in Settings.");
    return result.access_token;
  }

  async disconnectGoogleDrive(actorId: string, ownerType: "admin" | "customer" = "admin", ownerId?: string) {
    const key = this.googleDriveConnectionKey(ownerType, ownerId);
    await this.settings.deleteOne({ key });
    if (ownerType === "admin") await this.settings.deleteOne({ key: "google-drive" });
    await this.settings.deleteMany({ key: { $regex: "^google-oauth-state:" }, updatedBy: actorId });
    this.logger.warn("Google Drive disconnected by " + actorId + " (" + ownerType + ")");
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
