/** Typed environment access with fail-fast validation for production. */

const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return `dev-insecure-${name.toLowerCase()}`;
  }
  return value;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.API_PORT ?? "4000", 10),
  webUrl: process.env.WEB_URL ?? "http://localhost:3000",
  panelDomain: process.env.PANEL_DOMAIN ?? "panel.nimbushost.com",
  hostingDomain: process.env.HOSTING_DOMAIN ?? "nimbushost.com",
  mongoUri: process.env.MONGODB_URI ?? "mongodb://localhost:27017/nimbus",
  jwtSecret: required("JWT_SECRET", "dev-insecure-jwt-secret"),
  integrationEncryptionKey: required("INTEGRATION_ENCRYPTION_KEY", process.env.JWT_SECRET ?? "dev-insecure-integration-key"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@gmail.com",
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "admin",
  agentSharedSecret: required("AGENT_SHARED_SECRET", "dev-insecure-agent-secret"),
  enrollmentTokenTtlMinutes: parseInt(
    process.env.AGENT_ENROLLMENT_TOKEN_TTL_MINUTES ?? "30",
    10,
  ),
  firebaseCredentialsBase64: process.env.FIREBASE_ADMIN_CREDENTIALS_BASE64 ?? "",
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  cloudflareZoneId: process.env.CLOUDFLARE_ZONE_ID ?? "",
  portRangeStart: parseInt(process.env.DEFAULT_PORT_RANGE_START ?? "4001", 10),
  portRangeEnd: parseInt(process.env.DEFAULT_PORT_RANGE_END ?? "4050", 10),
};

export const isProduction = env.nodeEnv === "production";
