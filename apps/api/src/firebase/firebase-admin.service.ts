import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { env } from "../config/env";

/**
 * Firebase Admin SDK wrapper. Lazy-initialised so the API still boots
 * (local JWT auth works) when Firebase credentials are not yet configured —
 * the admin can configure Firebase later from Admin → Platform → Firebase.
 */
@Injectable()
export class FirebaseAdminService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app: import("firebase-admin/app").App | null = null;

  async onModuleInit(): Promise<void> {
    if (!env.firebaseCredentialsBase64) {
      this.logger.warn(
        "FIREBASE_ADMIN_CREDENTIALS_BASE64 not set — Firebase token validation disabled until configured.",
      );
      return;
    }
    try {
      const json = JSON.parse(
        Buffer.from(env.firebaseCredentialsBase64, "base64").toString("utf8"),
      ) as { project_id?: string };
      const admin = await import("firebase-admin/app");
      const credential = await import("firebase-admin/credential");
      this.app = admin.initializeApp(
        { credential: credential.cert(json as never), projectId: json.project_id },
        "nimbus-api",
      );
      this.logger.log(`Firebase Admin initialised for project ${json.project_id}`);
    } catch (err) {
      this.logger.error(`Firebase Admin init failed: ${(err as Error).message}`);
    }
  }

  get configured(): boolean {
    return this.app !== null;
  }

  /** Verify a Firebase ID token coming from the web client. */
  async verifyIdToken(idToken: string): Promise<{ uid: string; email?: string; name?: string }> {
    if (!this.app) throw new Error("Firebase is not configured on this installation");
    const auth = await import("firebase-admin/auth");
    const decoded = await auth.getAuth(this.app).verifyIdToken(idToken, true);
    return { uid: decoded.uid, email: decoded.email, name: decoded.name };
  }

  /** Custom claims keep internal permissions OUT of Firebase entirely. */
  async setRole(uid: string, role: string): Promise<void> {
    if (!this.app) throw new Error("Firebase is not configured on this installation");
    const auth = await import("firebase-admin/auth");
    await auth.getAuth(this.app).setCustomUserClaims(uid, { nimbusRole: role });
  }
}
